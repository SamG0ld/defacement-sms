import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

import * as Sentry from "@sentry/nextjs";

import { clientIpFromHeaders } from "@/lib/client-ip";
// #272. @sentry/nextjs was already in this bundle (via @/lib/ratelimit →
// @/lib/log); what changed is that the edge SDK is now actually enabled, so
// these calls stop being no-ops. logError is internally guarded and never throws.
import { logError } from "@/lib/log";
import { checkAuthRateLimit } from "@/lib/ratelimit";
import {
  buildCsp,
  cspResponseHeaderName,
  generateNonce,
  resolveCspMode,
  type CspMode,
} from "@/lib/csp";

// /invite is intentionally absent until the invitation flow ships — no point
// leaving an unauthenticated public prefix for a route that doesn't exist.
// /api/health (liveness) and /api/ready (DB readiness) are unauthenticated so
// container/orchestrator healthchecks (Docker HEALTHCHECK, uptime-kuma) can probe
// without a session.
// /sw.js + /offline are the PWA shell: the service-worker script and its offline
// fallback page must be fetchable without a session (the SW registers on the
// public /login page too, and the offline page renders when there's no network),
// and neither carries any user data.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  // DB-readiness probe (m17 #86): same unauthenticated rationale as /api/health,
  // but it runs `SELECT 1` so a post-startup DB outage reports the pod unhealthy.
  "/api/ready",
  // CSP violation reports are posted by the browser outside any session.
  "/api/csp-report",
  // The scheduled retention purge runs with no session (Vercel Cron); it
  // enforces its own CRON_SECRET bearer and fails closed without it. Allowlist
  // the exact path, not the /api/cron prefix, so a future cron route can't
  // become internet-public by accident.
  "/api/cron/purge-login-audit",
  // The Vercel Spend Management webhook (denial-of-wallet auto-pause, m16) arrives
  // with no session; the route verifies its own HMAC-SHA1 x-vercel-signature and
  // fails closed when the secret is unset. Allowlist the exact path (not the
  // /api/webhooks prefix) so a future webhook route can't become internet-public
  // by accident — same containment as the cron allowlist above.
  "/api/webhooks/vercel-spend",
  "/sw.js",
  "/offline",
];

// Rate-limit the surfaces an unauthenticated attacker can hit cheaply.
const RATE_LIMITED_AUTH_PREFIXES = [
  "/api/auth/signin",
  "/api/auth/callback",
];

function isPublic(pathname: string): boolean {
  // Segment-aware: an entry matches the exact path or a sub-path under it, never a
  // bare string prefix — so a future "/api/ready-internal" can't become public just
  // by sharing a prefix with "/api/ready" (the same accidental-exposure containment
  // the exact-path cron/webhook entries above were chosen for).
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function isRateLimitedAuthPath(pathname: string): boolean {
  return RATE_LIMITED_AUTH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

// Rate-limit key. Reads x-forwarded-for from the RIGHT so a client can't forge a
// fresh budget by prepending its own entry — see lib/client-ip.ts for the full
// proxy trust assumption (and TRUST_PROXY_DEPTH for chained proxies). Shared with
// the login Server Actions (lib/sign-in.ts) and /api/csp-report so all three
// IP-keyed limiters derive the key identically.
function getClientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers);
}

// Stamp the nonce-bearing CSP onto a pass-through response under the mode's header
// name (enforce → Content-Security-Policy, report → -Report-Only). The matching
// request header (set in proxy) is what Next reads to nonce its <script> tags.
function withCsp(res: NextResponse, csp: string, mode: CspMode): NextResponse {
  res.headers.set(cspResponseHeaderName(mode), csp);
  return res;
}

// enforce vs report is process-static (env-derived) — resolve once at module load.
const CSP_MODE = resolveCspMode();

// The unauthenticated answer, shared by the normal gate and the failure path so
// both speak the same protocol: API clients (the offline-sync engines) need a
// real 401 to classify as auth-expiry; humans get the login page.
function unauthenticated(
  req: NextRequest,
  pathname: string,
  search: string,
): NextResponse {
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(loginUrl);
}

// proxy.ts runs on nearly every request, so an UNTHROTTLED failure log here is a
// hazard in its own right: one bad deploy (say AUTH_SECRET unreadable in this
// runtime) would emit a stderr line plus a Sentry event per request, and an
// attacker who noticed could amplify it at will. That burns Vercel log and Sentry
// quota — denial-of-wallet, which this repo already treats as a real threat — and
// worse, quota exhaustion blinds the team to the very incident being reported.
// Same warn-once instinct as lib/ratelimit.ts / lib/csp.ts / lib/sentry-dsn.ts,
// but time-boxed per scope so a later distinct failure still surfaces, and
// carrying a `suppressed` count so the throttling itself is never invisible.
const FAILURE_LOG_INTERVAL_MS = 10_000;
const failureLogState = new Map<string, { at: number; suppressed: number }>();

function logFailure(scope: string, err: unknown, pathname: string): void {
  const now = Date.now();
  const state = failureLogState.get(scope);
  if (state && now - state.at < FAILURE_LOG_INTERVAL_MS) {
    failureLogState.set(scope, { at: state.at, suppressed: state.suppressed + 1 });
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  failureLogState.set(scope, { at: now, suppressed: 0 });
  logError(scope, err, {
    pathname,
    ...(suppressed > 0 ? { suppressed } : {}),
  });
}

/** Test-only: clear the failure-log throttle between cases. */
export function __resetProxyFailureThrottle(): void {
  failureLogState.clear();
}

// #272: proxy.ts is the edge auth gate and rate limiter — it runs on nearly every
// request, and a throw here used to produce NO signal at all (no structured line,
// and no Sentry event either, because the edge SDK was disabled). Everything it
// can throw now lands here.
//
// SECURITY DECISION — the auth path fails CLOSED. This gate could not establish a
// session, so the request is treated as unauthenticated rather than passed
// through. "Closed" deliberately means *unauthenticated*, not 503: the app stays
// reachable and the user can re-auth, and a blanket 503 would turn any middleware
// bug into a total outage without buying any safety (every page has its own
// lib/page-guards check and every non-public route its own requireApiSession).
// Explicitly NOT `NextResponse.next()` — that would pass traffic through AND drop
// the CSP header and the rate limit silently.
function middlewareFailure(
  req: NextRequest,
  err: unknown,
  event?: NextFetchEvent,
): NextResponse {
  const { pathname, search } = req.nextUrl;
  logFailure("proxy", err, pathname);
  // Edge isolates can be frozen the moment the response is returned, and this app
  // does not use withSentryConfig — so Next's middleware wrapper, which normally
  // flushes, is never applied and captureException is fire-and-forget. Without
  // this the stderr line survives and the Sentry event silently does not.
  // waitUntil keeps the isolate alive without delaying the response.
  try {
    event?.waitUntil(Sentry.flush(2000));
  } catch {
    /* observability must never break the request path */
  }

  // A public path cannot "fail closed" by redirecting to /login — /login is
  // itself public, so that is an infinite redirect loop. Degrade deliberately.
  // Note this DOES mean a persistent fault takes /login and the PWA shell down;
  // that is accepted because no request shape can reach it (every input-handling
  // call on the public path either cannot throw or is caught) — it takes a
  // deploy-level fault, which is already a total outage.
  if (isPublic(pathname)) {
    return new NextResponse("Service temporarily unavailable", {
      status: 503,
      // Give clients (and the offline-sync engines) a backoff signal, and forbid
      // any intermediary from holding on to the failure.
      headers: { "Retry-After": "5", "Cache-Control": "no-store" },
    });
  }
  return unauthenticated(req, pathname, search);
}

// Next passes a NextFetchEvent as the second argument to middleware; it is
// optional here only so unit tests can call proxy(req) directly.
export async function proxy(req: NextRequest, event?: NextFetchEvent) {
  try {
    return await handleRequest(req);
  } catch (err) {
    return middlewareFailure(req, err, event);
  }
}

async function handleRequest(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Apex landing: on the bare public domain (LANDING_APEX_HOST), the root path
  // serves the /login "door" so visitors land on the placard. Env-gated — unset
  // in dev/staging → no behavior change, and the app subdomain is never matched.
  // Only UNauthenticated visitors are rewritten; an authenticated apex visitor
  // falls through to the normal flow and gets the app at "/" (the same app is
  // served on both domains). That fall-through is also what avoids a
  // rewrite⇄redirect loop — the rewritten /login would otherwise redirect an
  // authed user back to "/". Rewrite (not redirect) keeps the URL on the apex so
  // the landing→boot→sign-in flow stays same-origin. The rewritten /login is
  // public, so it carries the same nonce-bearing CSP as every other response.
  // Normalize the configured apex host so a copy-paste slip in the env var
  // (scheme prefix, trailing path/slash, port, or stray whitespace) still
  // matches the request host — any of those silently breaks the landing rewrite.
  const apexHost = process.env.LANDING_APEX_HOST?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .split(":")[0]
    .toLowerCase();
  const reqHost = req.headers.get("host")?.trim().split(":")[0].toLowerCase();
  if (apexHost && pathname === "/" && reqHost === apexHost) {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
      secureCookie: process.env.NODE_ENV === "production",
    });
    if (!token || token.isActive === false) {
      const nonce = generateNonce();
      const csp = buildCsp(nonce);
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set("Content-Security-Policy", csp);
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      return withCsp(
        NextResponse.rewrite(url, { request: { headers: requestHeaders } }),
        csp,
        CSP_MODE,
      );
    }
    // Authenticated → fall through; "/" serves the app on the apex too.
  }

  if (isRateLimitedAuthPath(pathname)) {
    // The one deliberate fail-OPEN in this file. lib/ratelimit.ts already fails
    // open when Upstash is unconfigured; keep that posture when it is configured
    // but unreachable — an Upstash blip must not take the login path down on the
    // con floor. Logged, so "the limiter is currently off" is never silent.
    let verdict: Awaited<ReturnType<typeof checkAuthRateLimit>> | null = null;
    try {
      verdict = await checkAuthRateLimit(getClientIp(req));
    } catch (err) {
      logFailure("proxy.ratelimit", err, pathname);
    }
    if (verdict && !verdict.success) {
      const { remaining, reset } = verdict;
      // 429: plain-text body has no script context; CSP omitted intentionally.
      return new NextResponse("Too many authentication attempts", {
        status: 429,
        headers: {
          "Retry-After": Math.max(0, Math.ceil((reset - Date.now()) / 1000)).toString(),
          "X-RateLimit-Remaining": remaining.toString(),
        },
      });
    }
  }

  // Per-request CSP nonce: set on the REQUEST headers so Next stamps it onto its
  // framework/hydration <script> tags, and (via withCsp) on the RESPONSE so the
  // browser enforces it. Single CSP source — next.config.ts no longer sets one.
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Content-Security-Policy", csp);

  if (isPublic(pathname)) {
    return withCsp(
      NextResponse.next({ request: { headers: requestHeaders } }),
      csp,
      CSP_MODE,
    );
  }

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  });

  if (!token || token.isActive === false) {
    // API routes speak JSON, not HTML: a fetch-based client (the offline-sync
    // engines) follows a 307→/login and chokes on the login page's HTML. Answer
    // with a real 401 so the client classifies it as auth-expiry and prompts a
    // re-auth instead of stalling the outbox as "offline".
    return unauthenticated(req, pathname, search);
  }

  return withCsp(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
    CSP_MODE,
  );
}

export const config = {
  matcher: [
    /*
     * Run on all routes except:
     * - Next.js internals (_next/static, _next/image)
     * - favicon and static assets
     * - public assets in /public served at root with file extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)",
  ],
};
