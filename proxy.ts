import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

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
// /api/health is unauthenticated so container/orchestrator healthchecks (Docker
// HEALTHCHECK, uptime-kuma) can probe without a session.
// /sw.js + /offline are the PWA shell: the service-worker script and its offline
// fallback page must be fetchable without a session (the SW registers on the
// public /login page too, and the offline page renders when there's no network),
// and neither carries any user data.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  // CSP violation reports are posted by the browser outside any session.
  "/api/csp-report",
  // The scheduled retention purge runs with no session (Vercel Cron); it
  // enforces its own CRON_SECRET bearer and fails closed without it. Allowlist
  // the exact path, not the /api/cron prefix, so a future cron route can't
  // become internet-public by accident.
  "/api/cron/purge-login-audit",
  "/sw.js",
  "/offline",
];

// Rate-limit the surfaces an unauthenticated attacker can hit cheaply.
const RATE_LIMITED_AUTH_PREFIXES = [
  "/api/auth/signin",
  "/api/auth/callback",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isRateLimitedAuthPath(pathname: string): boolean {
  return RATE_LIMITED_AUTH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
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

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isRateLimitedAuthPath(pathname)) {
    const ip = getClientIp(req);
    const { success, remaining, reset } = await checkAuthRateLimit(ip);
    if (!success) {
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
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
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
