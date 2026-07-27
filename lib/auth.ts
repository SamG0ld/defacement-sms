import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/db";
import { withDbRetry } from "@/lib/db-retry";
import { logError } from "@/lib/log";
import { recordAudit } from "@/lib/audit";
import {
  canReceiveMagicLink,
  equalizeMagicLinkLatency,
  sendMagicLinkEmail,
} from "@/lib/email";
import { captureRequestContext } from "@/lib/request-context";
import type { UserRole } from "@/app/generated/prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      isActive: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: UserRole;
    isActive?: boolean;
    tokenVersion?: number;
    lastChecked?: number;
  }
}

// How often the JWT callback re-reads the user from the database to pick up
// role changes, deactivation, and tokenVersion bumps. Reduced to 15 min for
// DEF CON: a lost phone or demoted account loses access within 15 minutes of
// the next request — much tighter kill-switch propagation than the previous 1h
// window, while still costing only ~four DB reads per active session per hour,
// negligible at this team size. Raise to 60 * 60 * 1000 post-con if the
// extra DB load ever becomes a concern.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// When a refresh hits a transient DB failure we keep the session (fail-soft) and
// schedule the next kill-switch re-check this far out — rather than leaving the
// token stale, which would make EVERY subsequent request re-hit the DB (and pay
// the connect-retry stall) during a sustained outage. Far shorter than the 15-min
// window, so a revoked/demoted account is still re-validated quickly once the DB
// recovers; the only cost is the kill-switch staying paused for at most this long
// into an active outage — when the DB is unreachable and can't enforce it anyway.
const SOFT_FAIL_RECHECK_MS = 60 * 1000;

// First-admin bootstrap. Emails listed in BOOTSTRAP_ADMIN_EMAILS may
// self-provision as admin on first Google sign-in — the minimal unblock before
// the invitation flow exists. Clear the var once invites are wired up.
// Emit the prod-footgun warning at most once per process (M17 #58). The check
// runs on every sign-in, so an unguarded warn would log the bootstrap state on
// every attempt — a recon signal. Once is enough to flag the misconfig; we also
// no longer log the address count (provisioning-state leak).
let bootstrapWarned = false;

function isBootstrapAdmin(email: string): boolean {
  const list = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // Warn loudly (once) if this var is still set in production — it's a footgun
  // that should be cleared once real admins exist.
  if (process.env.NODE_ENV === "production" && list.length > 0 && !bootstrapWarned) {
    bootstrapWarned = true;
    console.warn(
      "[auth] BOOTSTRAP_ADMIN_EMAILS is still set in production. " +
        "Clear it once you have at least one confirmed admin.",
    );
  }
  return list.includes(email.toLowerCase());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
    // 7 days. Shared phones at DEF CON shouldn't carry a 30-day session.
    maxAge: 7 * 24 * 60 * 60,
    // Rotate the cookie at least daily. The jwt callback re-reads the DB within
    // REFRESH_INTERVAL_MS (15 min) of an active user's next request, so a
    // tokenVersion / isActive / role change propagates within 15 minutes.
    updateAge: 24 * 60 * 60,
  },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // Required for the invitation flow: an admin pre-creates a User row by
      // email, then the invitee signs in with Google and the OAuth account
      // links to the existing User. Safe here because only admins can create
      // users; if that ever changes, this becomes an impersonation vector.
      allowDangerousEmailAccountLinking: true,
    }),
    // Passwordless magic link — the universal path for teammates whose email
    // backend isn't Google/Microsoft. Sending is gated to known active users in
    // sendVerificationRequest so registration stays closed (no enumeration, no
    // self-provisioning). Uses Resend's REST API (lib/magic-link.ts), not SMTP.
    Resend({
      // apiKey/from are intentionally omitted: the built-in sender that would
      // consume them is replaced below, and sendMagicLinkEmail reads the env
      // vars directly. Passing them here would be dead, misleading config.
      //
      // Token lifetime. NextAuth's default is 24h — a ~100x wider interception
      // window than the "expires in 15 minutes" the email/UI promises, and too
      // long for the shared-phone threat model. 15 minutes is plenty to open
      // an inbox.
      maxAge: 15 * 60,
      async sendVerificationRequest({ identifier, url }) {
        const email = identifier.toLowerCase();
        const user = await prisma.user.findUnique({
          where: { email },
          select: { isActive: true },
        });
        // Closed registration: only mail a known active user — never create a
        // row, never send to a stranger.
        //
        // Defense in depth, not the primary gate: @auth/core runs the signIn
        // callback BEFORE this hook (lib/actions/signin/send-token.js), and that
        // callback already rejects any non-team / deactivated address with
        // AccessDenied. Reaching this branch takes a deactivation landing between
        // those two independent reads, with no transaction spanning them — rare,
        // but the check stays so the guarantee holds locally if that ordering
        // ever changes.
        //
        // Enumeration (#227) is therefore NOT solved here: the observable
        // difference is the AccessDenied rejection itself, which is normalized to
        // the ordinary "link dispatched" screen in lib/sign-in.ts. The jitter
        // below only keeps this path's latency comparable to a real send on the
        // rare occasion it is reached. Volume is bounded by the per-IP limit the
        // login Server Actions apply (lib/sign-in.ts, #173) — NOT by proxy.ts,
        // which never covered this call path.
        if (!canReceiveMagicLink(user)) {
          await equalizeMagicLinkLatency();
          return;
        }
        try {
          await sendMagicLinkEmail(email, url);
        } catch (err) {
          // Durable signal that a teammate's sign-in link didn't go out — the
          // user only ever sees "check your inbox". No raw email in the log/Sentry.
          logError("email.magic-link-failed", err);
          throw err;
        }
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
    // Post-submit "check your inbox" screen is our own login page rather than
    // NextAuth's default unstyled verify-request page. MUST stay query-less:
    // NextAuth appends its own search (?provider=resend&type=email) here WITHOUT
    // inserting a separator (@auth/core pages/index.js), so a value with a query
    // would produce a malformed `…?a=1?b=2`. The login page reads the appended
    // `type=email` as the "magic link sent" signal.
    verifyRequest: "/login",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!user.email) return false;

      // Normalize: stored rows are lowercased (addUser / seeds), but OAuth can
      // return mixed case. Compare case-insensitively or the gate + kill-switch
      // silently disagree with the jwt callback.
      const email = user.email.toLowerCase();
      const provider = account?.provider;

      // Best-effort denial audit: record a rejected sign-in (auth.denied) with
      // the reason + coarse location/device, then return false. Never throws —
      // recordAudit and captureRequestContext both swallow their own errors, so
      // logging can't turn a rejection into a 500.
      const deny = async (reason: string): Promise<false> => {
        const ctx = await captureRequestContext();
        await recordAudit({
          action: "auth.denied",
          // Attacker-asserted on a rejected attempt — bound length (RFC 5321 max).
          actorEmail: email.slice(0, 320),
          detail: `${provider ?? "unknown"} · ${reason}`,
          userAgent: ctx.userAgent,
          location: ctx.location,
        });
        return false;
      };

      // allowDangerousEmailAccountLinking links a Google login to a pre-created
      // User row purely by matching email. Require Google to have VERIFIED that
      // email, so a pre-provisioned row (possibly admin) can't be hijacked by an
      // account asserting an unverified address. Enforced in code, not just by
      // trusting the provider.
      const emailVerified = (profile as { email_verified?: boolean } | undefined)
        ?.email_verified;
      if (provider === "google" && emailVerified === false) {
        return deny("email unverified");
      }

      // Closed registration. NextAuth's Prisma adapter will auto-create a User
      // row on first OAuth sign-in using schema defaults (role=volunteer,
      // isActive=true), so without a gate here ANY Google account would
      // self-provision an active account. Only accounts an admin has
      // pre-created (the invitation flow) may sign in: we reject any email with
      // no pre-existing row here, before the adapter persists anything.
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { isActive: true },
      });

      // Magic-link (resend) sign-in must never self-provision — bootstrap is
      // Google-only. A link is only ever mailed to an existing active user
      // (see the Resend provider's sendVerificationRequest), so this is
      // defense-in-depth: require the active row, no bootstrap branch.
      if (provider === "resend") {
        if (!existing) return deny("not on team");
        if (!existing.isActive) return deny("deactivated");
        return true;
      }

      // No row yet: only a configured bootstrap admin may self-provision.
      if (!existing) {
        if (isBootstrapAdmin(email)) return true;
        return deny("not on team");
      }
      // Existing account: must still be active.
      if (!existing.isActive) return deny("deactivated");
      return true;
    },
    async redirect({ url, baseUrl }) {
      // Open-redirect protection: anything passed via ?callbackUrl= must be
      // either a relative path or same-origin. Anything else falls back to
      // the app root.
      if (url.startsWith("/")) {
        return `${baseUrl}${url}`;
      }
      try {
        const parsed = new URL(url);
        if (parsed.origin === baseUrl) return url;
      } catch {
        // Fall through to baseUrl
      }
      return baseUrl;
    },
    async jwt({ token, user, account, trigger }) {
      const rawEmail = (user?.email ?? token.email) as string | undefined;
      if (!rawEmail) return token;
      const email = rawEmail.toLowerCase();

      const lastChecked = token.lastChecked ?? 0;
      const isStale = Date.now() - lastChecked > REFRESH_INTERVAL_MS;
      // No userId yet means this is the initial token being built at sign-in;
      // it legitimately has no tokenVersion claim yet.
      const isInitial = token.userId === undefined;

      const needsRefresh =
        trigger === "signIn" ||
        trigger === "signUp" ||
        trigger === "update" ||
        isInitial ||
        isStale;

      if (!needsRefresh) return token;

      // An actual authentication (signIn/signUp, or the initial token build) vs.
      // a plain staleness/`update` refresh. The distinction drives how a DB
      // outage is handled in the catch below.
      const isSignIn =
        trigger === "signIn" || trigger === "signUp" || isInitial;

      // Resilience: a scale-to-zero database cold start can refuse / time out the
      // first connection after idle. withDbRetry retries that transient blip once
      // (the first attempt wakes the compute, the retry lands warm). A failure
      // that survives the retry is an infra outage — NOT an authoritative "no
      // such user" — so it must not be mistaken for a deactivation.
      let dbUser: {
        id: string;
        role: UserRole;
        isActive: boolean;
        tokenVersion: number;
        firstLoginAt: Date | null;
      } | null;
      try {
        dbUser = await withDbRetry(
          () =>
            prisma.user.findUnique({
              where: { email },
              select: {
                id: true,
                role: true,
                isActive: true,
                tokenVersion: true,
                firstLoginAt: true,
              },
            }),
          { scope: "auth.jwt.findUser" },
        );
      } catch (err) {
        logError("auth.jwt.db-unavailable", err, {
          phase: isSignIn ? "signin" : "refresh",
        });
        // Sign-in: there's no established session to preserve, and minting a
        // half-built token would wedge the user. Surface the failure so NextAuth
        // routes to the login error screen — a retry usually lands once warm.
        if (isSignIn) throw err;
        // Refresh of an already-valid session: fail SOFT — keep the user signed in
        // through the blip. Nudge lastChecked forward so the kill-switch re-checks
        // after SOFT_FAIL_RECHECK_MS instead of on every request (which would stall
        // each page load on the connect-retry during a sustained outage), while
        // still re-validating far sooner than the normal 1h staleness window once
        // the database recovers. A transient blip must not sign out the whole team mid-floor.
        return {
          ...token,
          lastChecked: Date.now() - REFRESH_INTERVAL_MS + SOFT_FAIL_RECHECK_MS,
        };
      }

      // Revoked: drop to the lowest rank alongside isActive (#238). Spreading the
      // prior token would keep whatever role was cached before deactivation, so a
      // deactivated admin's token still *read* as admin. Every authz consumer
      // checks isActive first (lib/rbac.ts, lib/page-guards.ts), so nothing is
      // exploitable today — this is defense in depth for the next consumer that
      // reaches for session.user.role without that check. "volunteer" is what the
      // session callback already falls back to below.
      if (!dbUser || !dbUser.isActive) {
        return { ...token, isActive: false, role: "volunteer" };
      }

      // tokenVersion kill-switch — fail CLOSED. An established token (already
      // carries userId) whose version doesn't match the DB is revoked; a token
      // missing the claim entirely coerces to -1 and also fails. Skipped only on
      // the initial sign-in, when the version is being populated for the first
      // time.
      if (!isInitial && (token.tokenVersion ?? -1) !== dbUser.tokenVersion) {
        // Same stale-role reset as the branch above — a kill-switched token must
        // not carry a privileged role either.
        return { ...token, isActive: false, role: "volunteer" };
      }

      // First-admin bootstrap: promote a configured email to admin exactly
      // ONCE — on first login only (firstLoginAt still null). Gating on
      // firstLoginAt means a later admin-initiated demotion sticks instead of
      // being silently re-promoted on every refresh. Done here (not a
      // createUser event) so the freshly promoted role flows into this token.
      // Bootstrap is **Google-only**: a bootstrap-listed email that first signs
      // in via magic-link (a non-Google provider) must NOT auto-promote. account
      // is present on the initial sign-in — the only time firstLoginAt is null
      // and promotion can fire.
      let role = dbUser.role;
      const promote =
        role !== "admin" &&
        isBootstrapAdmin(email) &&
        !dbUser.firstLoginAt &&
        account?.provider === "google";
      if (promote) role = "admin";

      // Single write on actual sign-in: stamp login timestamps and apply any
      // bootstrap promotion. Background staleness refreshes don't touch these.
      // Best-effort: a failed write must not fail an otherwise-valid sign-in. The
      // promotion still applies to THIS token via `role`; an unpersisted promote
      // simply re-fires next login (firstLoginAt stays null), so it converges.
      if (isSignIn || promote) {
        const userId = dbUser.id;
        const hadFirstLogin = dbUser.firstLoginAt;
        try {
          await withDbRetry(
            () =>
              prisma.user.update({
                where: { id: userId },
                data: {
                  ...(promote ? { role: "admin" as const } : {}),
                  ...(isSignIn
                    ? {
                        lastLoginAt: new Date(),
                        ...(hadFirstLogin ? {} : { firstLoginAt: new Date() }),
                      }
                    : {}),
                },
              }),
            { scope: "auth.jwt.loginStamp" },
          );
        } catch (err) {
          logError("auth.jwt.login-stamp-failed", err, { userId });
        }
      }

      // Login audit (best-effort): one auth.login row per genuine sign-in, with
      // coarse location (Vercel geo headers) + device. Gated on isSignIn
      // (trigger signIn/signUp, or isInitial — a token populated for the first
      // time); the hourly staleness refresh always carries userId, so it never
      // reaches here. Narrower than the user.update guard above (isSignIn ||
      // promote) on purpose: promote can only fire on the first-ever login, when
      // isSignIn is already true, so no login is missed. No raw IP captured; runs
      // in the NextAuth Node route handler, so headers() resolves.
      if (isSignIn) {
        const ctx = await captureRequestContext();
        await recordAudit({
          action: "auth.login",
          actorId: dbUser.id,
          actorEmail: email,
          detail: account?.provider === "resend" ? "magic-link" : account?.provider ?? "session",
          userAgent: ctx.userAgent,
          location: ctx.location,
        });
      }

      return {
        ...token,
        userId: dbUser.id,
        role,
        isActive: dbUser.isActive,
        tokenVersion: dbUser.tokenVersion,
        lastChecked: Date.now(),
      };
    },
    async session({ session, token }) {
      if (token.userId && session.user) {
        session.user.id = token.userId;
        session.user.role = token.role ?? "volunteer";
        session.user.isActive = token.isActive ?? false;
      }
      return session;
    },
  },
});
