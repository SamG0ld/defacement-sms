import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/db";
import { canReceiveMagicLink, sendMagicLinkEmail } from "@/lib/email";
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
// role changes, deactivation, and tokenVersion bumps. 1h bounds the kill-switch
// / role-change propagation latency (AR-3) — a lost shared phone or a demoted
// account loses access within the hour of its next request — while costing only
// ~one DB read per active session per hour, negligible at this team size.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// First-admin bootstrap. Emails listed in BOOTSTRAP_ADMIN_EMAILS may
// self-provision as admin on first Google sign-in — the minimal unblock before
// the invitation flow exists. Clear the var once invites are wired up.
function isBootstrapAdmin(email: string): boolean {
  const list = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
    // 7 days. Shared phones at DEF CON shouldn't carry a 30-day session.
    maxAge: 7 * 24 * 60 * 60,
    // Rotate the cookie at least daily. The jwt callback re-reads the DB within
    // REFRESH_INTERVAL_MS (1h) of an active user's next request, so a
    // tokenVersion / isActive / role change propagates within the hour.
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
        // Closed registration: only mail a known active user. Non-users still
        // see the "check your inbox" screen (NextAuth already redirected) but
        // get no email and no row is created — same UX, no enumeration via
        // content.
        //
        // Accepted residual: the active-user path then awaits a network send,
        // so its response is measurably slower than the early-return non-user
        // path — a timing oracle for "is this address on the team?". Tolerated
        // given the per-IP auth rate limit (proxy.ts) and a tiny known roster;
        // equalizing would mean a fire-and-forget send that swallows real
        // delivery errors, which is the worse trade here.
        if (!canReceiveMagicLink(user)) return;
        await sendMagicLinkEmail(email, url);
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

      // allowDangerousEmailAccountLinking links a Google login to a pre-created
      // User row purely by matching email. Require Google to have VERIFIED that
      // email, so a pre-provisioned row (possibly admin) can't be hijacked by an
      // account asserting an unverified address. Enforced in code, not just by
      // trusting the provider.
      const emailVerified = (profile as { email_verified?: boolean } | undefined)
        ?.email_verified;
      if (account?.provider === "google" && emailVerified === false) {
        return false;
      }

      // Normalize: stored rows are lowercased (addUser / seeds), but OAuth can
      // return mixed case. Compare case-insensitively or the gate + kill-switch
      // silently disagree with the jwt callback.
      const email = user.email.toLowerCase();

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
      if (account?.provider === "resend") {
        return !!existing && existing.isActive;
      }

      // No row yet: only a configured bootstrap admin may self-provision.
      if (!existing) return isBootstrapAdmin(email);
      // Existing account: must still be active.
      return existing.isActive;
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

      const dbUser = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          role: true,
          isActive: true,
          tokenVersion: true,
          firstLoginAt: true,
        },
      });

      if (!dbUser || !dbUser.isActive) {
        return { ...token, isActive: false };
      }

      // tokenVersion kill-switch — fail CLOSED. An established token (already
      // carries userId) whose version doesn't match the DB is revoked; a token
      // missing the claim entirely coerces to -1 and also fails. Skipped only on
      // the initial sign-in, when the version is being populated for the first
      // time.
      if (!isInitial && (token.tokenVersion ?? -1) !== dbUser.tokenVersion) {
        return { ...token, isActive: false };
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
      const isSignIn =
        trigger === "signIn" || trigger === "signUp" || isInitial;
      const promote =
        role !== "admin" &&
        isBootstrapAdmin(email) &&
        !dbUser.firstLoginAt &&
        account?.provider === "google";
      if (promote) role = "admin";

      // Single write on actual sign-in: stamp login timestamps and apply any
      // bootstrap promotion. Background staleness refreshes don't touch these.
      if (isSignIn || promote) {
        await prisma.user.update({
          where: { id: dbUser.id },
          data: {
            ...(promote ? { role: "admin" as const } : {}),
            ...(isSignIn
              ? {
                  lastLoginAt: new Date(),
                  ...(dbUser.firstLoginAt ? {} : { firstLoginAt: new Date() }),
                }
              : {}),
          },
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
