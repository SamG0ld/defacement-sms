// Request-shape guards for the /api/native/* route handlers. Pure with respect
// to auth (no session/DB imports) so they unit-test without the NextAuth chain;
// lib/deploy/api-session re-exports them for the routes.

import { ApiError } from "@/lib/deploy/api-types";

// CSRF guard for the cookie-authenticated mutation routes. The session rides on
// a sameSite=lax cookie, which still accompanies a top-level cross-site form
// POST — so reject any mutation whose browser-set metadata says it came from
// another origin. Requests with NEITHER header (curl, the future iOS
// bearer-token client) pass: a browser always sends Origin on a cross-site
// POST, so absent-both cannot be a CSRF.
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    throw new ApiError(403, "cross-origin request rejected");
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError(403, "cross-origin request rejected");
    }
    // x-forwarded-host first: on staging the TLS-terminating proxy rewrites
    // Host, and Vercel sets/strips x-forwarded-host platform-side.
    const expected =
      req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!expected || originHost.toLowerCase() !== expected.toLowerCase()) {
      throw new ApiError(403, "cross-origin request rejected");
    }
  }
}

// Parse a JSON request body, requiring the JSON content type. A cross-site HTML
// form can only send urlencoded / multipart / text-plain, so requiring
// application/json (which the PWA client already sends) closes the
// enctype="text/plain" smuggle as a second CSRF belt.
export async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "expected application/json");
  }
  return req.json();
}
