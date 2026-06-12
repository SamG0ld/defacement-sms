import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Rate limiter is best-effort. If Upstash env vars are missing (typical for
// local dev), every check returns success — the app keeps working, just
// without DDoS/brute-force protection. In production both vars are required;
// see Setup Credentials note.
const isConfigured =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = isConfigured ? Redis.fromEnv() : null;

const authLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "1 m"),
      analytics: true,
      prefix: "ratelimit:auth",
    })
  : null;

// Backstop for expensive authenticated actions (CSV import/export). Keyed on the
// user id so one account can't hammer the import/export pipeline.
const actionLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      analytics: true,
      prefix: "ratelimit:action",
    })
  : null;

// Per-actor backstop for the /api/native/* surface (offline sync drains, claims,
// photo serve). Generous — real floor cadence never approaches this; the point
// is stopping a hot-looped client from monopolizing the max:3 pg pool.
const nativeLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(300, "1 m"),
      analytics: true,
      prefix: "ratelimit:native",
    })
  : null;

// Per-actor backstop for the authenticated mutating Server Actions (generate,
// bulk zone/tag/delete, status, lifecycle). Roomier than the import/export
// bucket — 60/min is ~1 write per second sustained, beyond any hand-driven
// usage but a wall for a scripted hot loop.
const mutationLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, "1 m"),
      analytics: true,
      prefix: "ratelimit:mutate",
    })
  : null;

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  reset: number;
};

const OPEN: RateLimitResult = {
  success: true,
  remaining: Number.POSITIVE_INFINITY,
  reset: 0,
};

// The limiter is a best-effort backstop, so it fails OPEN: an Upstash outage or
// network blip must degrade to "no throttling", never take down login or the
// floor sync with it.
async function safeLimit(
  limiter: Ratelimit | null,
  key: string,
): Promise<RateLimitResult> {
  if (!limiter) return OPEN;
  try {
    const result = await limiter.limit(key);
    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (err) {
    console.error("rate limiter unavailable, failing open", err);
    return OPEN;
  }
}

export async function checkAuthRateLimit(
  ip: string,
): Promise<RateLimitResult> {
  return safeLimit(authLimiter, `auth:${ip}`);
}

export async function checkActionRateLimit(
  key: string,
): Promise<RateLimitResult> {
  return safeLimit(actionLimiter, key);
}

export async function checkNativeRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return safeLimit(nativeLimiter, `native:${userId}`);
}

export async function checkMutationRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return safeLimit(mutationLimiter, `mutate:${userId}`);
}

export function isRateLimitConfigured(): boolean {
  return isConfigured;
}
