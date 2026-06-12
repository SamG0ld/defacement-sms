// Auth + error plumbing for the /api/native/* JSON endpoints.
//
// Unlike Server Actions (which throw and let Next surface a redirect), a route
// handler must return explicit JSON + status codes. `requireApiSession` resolves
// the acting user and throws a typed `ApiError`; `runApi` wraps a handler
// body so that error — and a Zod validation failure — becomes a clean 401/403/
// 400 instead of a 500.
//
// Phase A1: cookie session only (the web PWA). Phase A2 (iOS) extends
// `requireApiSession` to also accept an `Authorization: Bearer <jwe>` via
// lib/native-auth.ts — the route handlers and service layer don't change.

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { auth } from "@/lib/auth";
import { checkNativeRateLimit } from "@/lib/ratelimit";
import { assertSameOrigin } from "@/lib/deploy/api-guards";
import { ApiError, type ApiActor } from "@/lib/deploy/api-types";

export { assertSameOrigin, readJsonBody } from "@/lib/deploy/api-guards";
export { ApiError } from "@/lib/deploy/api-types";
export type { ApiActor } from "@/lib/deploy/api-types";

// Resolve the acting user. Phase A1: cookie session only. Endpoints that need a
// role gate check `hasRole` from lib/rbac inline (the only one today is
// force-release, which *branches* on lead+ rather than rejecting) — so there's
// no general requireApiRole guard.
//
// Every native call also passes a generous per-actor rate limit here — the
// backstop that keeps one hot-looped client from monopolizing the max:3 pg
// pool. The limiter fails open (lib/ratelimit.ts), so an Upstash blip never
// takes the floor sync down; the client treats the 429 as retryable.
export async function requireApiSession(): Promise<ApiActor> {
  const session = await auth();
  if (!session?.user?.id || !session.user.isActive) {
    throw new ApiError(401, "unauthorized");
  }
  const limit = await checkNativeRateLimit(session.user.id);
  if (!limit.success) {
    throw new ApiError(429, "too many requests");
  }
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    role: session.user.role,
  };
}

export function apiError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

// Run a route-handler body, mapping known failures to JSON status codes. Takes
// the request so every native route gets the same-origin CSRF check without
// each handler remembering to call it.
export async function runApi(
  req: Request,
  fn: () => Promise<unknown>,
): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
    const data = await fn();
    return NextResponse.json(data ?? { ok: true });
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.status, err.message);
    if (err instanceof ZodError) {
      // Return only field path + message — never the received input value, which
      // bloats the response and needlessly echoes client data back.
      return NextResponse.json(
        {
          error: "invalid request",
          issues: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }
    console.error("/api/native error", err);
    return apiError(500, "internal error");
  }
}
