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

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  reset: number;
};

export async function checkAuthRateLimit(
  ip: string,
): Promise<RateLimitResult> {
  if (!authLimiter) {
    return { success: true, remaining: Number.POSITIVE_INFINITY, reset: 0 };
  }
  const result = await authLimiter.limit(`auth:${ip}`);
  return {
    success: result.success,
    remaining: result.remaining,
    reset: result.reset,
  };
}

export async function checkActionRateLimit(
  key: string,
): Promise<RateLimitResult> {
  if (!actionLimiter) {
    return { success: true, remaining: Number.POSITIVE_INFINITY, reset: 0 };
  }
  const result = await actionLimiter.limit(key);
  return {
    success: result.success,
    remaining: result.remaining,
    reset: result.reset,
  };
}

export function isRateLimitConfigured(): boolean {
  return isConfigured;
}
