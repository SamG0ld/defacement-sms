// Bodies of the two login Server Actions (app/(public)/login/page.tsx). They
// live here, not inline in the page, so they can be unit-tested; lib/ rather
// than beside the page because everything they coordinate — lib/auth, lib/email,
// lib/ratelimit, lib/client-ip — already lives here, and none of it is the
// door's presentation logic. page.tsx keeps the thin "use server" wrappers that
// bind the callback destination.
//
// Why these need their own rate-limit check (#173): a Server Action submission
// POSTs to the page's own URL (/login), which proxy.ts treats as a PUBLIC_PREFIX
// and never matches against RATE_LIMITED_AUTH_PREFIXES. Inside the action,
// next-auth's signIn() builds a synthetic Request and calls Auth() in-process —
// it never issues a real request to /api/auth/*, so middleware never runs again.
// The result was that the only sign-in path real users (and attackers) actually
// use was completely unthrottled: unlimited magic-link sends to any known
// address, unlimited probes against the roster-enumeration oracle handled below,
// and an unbounded write rate for the auth.denied audit rows each rejected
// attempt records. Checking here is what makes the limiter cover the real flow.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { equalizeMagicLinkLatency } from "@/lib/email";
import { logWarn } from "@/lib/log";
import { checkAuthRateLimit } from "@/lib/ratelimit";

// Shape check only — the client's <input type="email"> is bypassable via a
// direct POST, so the address is re-validated server-side.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The "your link is on its way" screen. Reached by a real teammate, an unknown
// address, and a malformed one alike — that identity is the anti-enumeration
// property, so keep every caller pointed at this same constant.
//
// This is NextAuth's own verify-request URL, not /login directly, because that is
// where a genuine send lands: @auth/core redirects a successful sendToken here,
// and this route then redirects to pages.verifyRequest (/login) with its own
// query appended — so a real teammate ends on "/login?provider=resend&type=email"
// after TWO hops. Redirecting straight to "/login?type=email" would leave a
// different final URL and one fewer hop for a non-team address: an address-bar
// visible oracle, just quieter than the 500 this replaced. Going through the same
// route makes both paths byte-identical to the browser.
//
// Costs no rate-limit budget: proxy.ts treats /api/auth as public and limits only
// the /api/auth/signin and /api/auth/callback prefixes.
const SENT_SCREEN = "/api/auth/verify-request?provider=resend&type=email";

// Throttle notice. Its copy lives in errorMessage() in the login page.
const THROTTLED_SCREEN = "/login?error=RateLimited";

// Did the closed-registration gate deliberately turn this address away?
//
// next-auth signals a rejected sign-in by throwing an AuthError whose `type` is
// "AccessDenied" (@auth/core throws rather than redirecting on the Server Action
// path, because next-auth calls Auth() with `raw`). Matched structurally on
// `type` rather than `instanceof`, because the AccessDenied class itself is only
// exported from @auth/core — a transitive dependency, not a declared one — and
// because a NEXT_REDIRECT carries `digest`, not `type`, so it can never be
// mistaken for a rejection and swallowed.
//
// The `cause` check is load-bearing. @auth/core's sendToken wraps the signIn
// callback in try/catch and rethrows ANY exception as `new AccessDenied(err)`,
// so an infrastructure failure inside the callback — e.g. its Prisma lookup
// dying on a database cold start — arrives here looking exactly like a roster
// rejection. AuthError's constructor tells them apart: given an Error it sets
// `cause.err`, given the plain "AccessDenied" string it sets no cause. Only the
// causeless form is a real rejection. Without this, a DB blip would quietly show
// a teammate "your link is on its way" and leave no trace anywhere.
//
// Corollary for anyone editing the signIn callback: throw only Error instances
// from it. A bare `throw "string"` would arrive causeless and be misread as a
// rejection. Tempting alternative — also requiring the message to be
// "AccessDenied" — does NOT work: AuthError's constructor appends
// ". Read more at <url>" to every message, so an equality check silently stops
// matching the real error and reopens the oracle.
function isRosterRejection(err: unknown): boolean {
  const e = err as { type?: string; cause?: { err?: unknown } } | null;
  return e?.type === "AccessDenied" && e.cause?.err === undefined;
}

// Spend one unit of the per-IP auth budget. Returns normally when the request is
// allowed; otherwise throws through redirect() to the throttle notice.
//
// The message is deliberately explicit rather than a silent fake-"sent" screen:
// the bucket is keyed per IP and never per address, so it reveals nothing about
// who is on the roster, while a real teammate sharing a con-wifi NAT gets a
// truthful signal instead of waiting on an email that was never sent.
async function spendAuthBudget(flow: "google" | "magic-link"): Promise<void> {
  const ip = clientIpFromHeaders(await headers());
  const { success } = await checkAuthRateLimit(ip);
  // Note lib/ratelimit.ts fails OPEN when Upstash is unconfigured or unreachable
  // (logged as ratelimit.fail-open) — an outage must degrade to "no throttling",
  // never lock the whole team out of signing in mid-floor.
  if (!success) {
    // A throttled sign-in is control flow, not an error: it redirects rather than
    // throwing, so without this nothing surfaces it anywhere — no exception, no
    // Sentry event, no counter. Someone reporting "I can't log in" on the floor
    // would be the first signal. warn-level on purpose: it lands in the Vercel
    // log viewer filterable by scope, but does NOT page via Sentry — under a real
    // attack that is exactly when per-attempt alerting is least useful.
    //
    // Carries neither the email nor the IP. lib/request-context.ts keeps this
    // app's audit trail deliberately IP-less and an observability nicety must not
    // quietly undo that; `flow` is enough to tell a mail-bomb attempt on the
    // magic-link path from OAuth churn.
    logWarn("auth.ratelimit.blocked", "sign-in throttled", { flow });
    redirect(THROTTLED_SCREEN);
  }
}

// No AccessDenied handling here, unlike the magic-link path below: Google's
// closed-registration rejection fires later, during the real HTTP request to
// /api/auth/callback/google (which proxy.ts rate-limits separately), not
// synchronously inside this action. There is nothing to normalize — and nothing
// to enumerate with, since reaching that callback means owning the account.
export async function startGoogleSignIn(dest: string): Promise<void> {
  await spendAuthBudget("google");
  await signIn("google", { redirectTo: dest });
}

export async function startMagicLinkSignIn(
  dest: string,
  rawEmail: string,
): Promise<void> {
  // Budget is spent BEFORE the shape check on purpose: otherwise malformed
  // submissions would be a free, unmetered probe against this endpoint.
  await spendAuthBudget("magic-link");
  const email = rawEmail.trim();
  // On a malformed value, short-circuit to the same "link dispatched"
  // confirmation WITHOUT calling signIn: identical to a valid-but-unknown
  // email, so the door never reveals whether an address is real (no
  // enumeration) and garbage never enters the auth pipeline.
  if (!EMAIL_SHAPE.test(email)) {
    redirect(SENT_SCREEN);
  }

  // Enumeration guard (#227). The closed-registration gate lives in lib/auth.ts's
  // signIn callback, and @auth/core runs that callback BEFORE
  // sendVerificationRequest (node_modules/@auth/core/lib/actions/signin/
  // send-token.js) — so a non-team address is rejected with AccessDenied and
  // never reaches the send. Left uncaught, that surfaces as a thrown error (a
  // 500 error boundary) while a real teammate gets redirected to the sent
  // screen: a one-request oracle answering "is this address on the team?", far
  // louder than the timing difference #227 was filed for. Normalize it — the
  // caller sees exactly the "link dispatched" screen either way, and the jitter
  // keeps the two paths' latency comparable on top of that.
  //
  // Deliberately narrow: ONLY a deliberate roster rejection is absorbed. A
  // genuine send failure, or an infra failure inside the gate, still reaches the
  // error screen — so a teammate whose link didn't go out is never told it did
  // (lib/email.ts logs the send failure). The closed-registration gate itself is
  // untouched: the rejection still happens, still writes its auth.denied audit
  // row, and still creates no user and no verification token.
  try {
    await signIn("resend", { email, redirectTo: dest });
  } catch (err) {
    if (!isRosterRejection(err)) throw err;
    await equalizeMagicLinkLatency();
    redirect(SENT_SCREEN);
  }
}
