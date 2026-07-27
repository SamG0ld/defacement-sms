import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rate limiter fails OPEN (no throttling) when Upstash is unconfigured or a
// call errors — that's deliberate for availability. These tests pin the fix that
// makes each fail-open observable in the logs instead of silently disappearing.
//
// `@/lib/log` is mocked so the assertions target the structured logger the app
// actually uses (and so the test doesn't drag in the Sentry runtime).
const logWarn = vi.fn();
const logError = vi.fn();
vi.mock("@/lib/log", () => ({ logWarn, logError }));

describe("ratelimit fail-open logging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    logWarn.mockClear();
    logError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("warns (once) when Upstash env is unset and fails open", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const { checkAuthRateLimit } = await import("@/lib/ratelimit");

    const first = await checkAuthRateLimit("1.2.3.4");
    const second = await checkAuthRateLimit("5.6.7.8");

    // Fails open: still allows the request.
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    // The degradation is logged, but only once (not per request).
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[0]).toBe("ratelimit.fail-open");
    expect(String(logWarn.mock.calls[0]?.[1])).toMatch(/fail(ing)? open/i);
    // A missing-config fail-open is not an error-level event.
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs an error when a configured limiter throws and fails open", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");

    vi.doMock("@upstash/redis", () => ({
      Redis: { fromEnv: () => ({}) },
    }));
    vi.doMock("@upstash/ratelimit", () => ({
      Ratelimit: class {
        static slidingWindow() {
          return {};
        }
        limit() {
          return Promise.reject(new Error("upstash down"));
        }
      },
    }));

    const { checkAuthRateLimit } = await import("@/lib/ratelimit");
    const result = await checkAuthRateLimit("1.2.3.4");

    // Fails open despite the thrown error.
    expect(result.success).toBe(true);
    // And the error is surfaced, once per occurrence, under the alertable scope.
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toBe("ratelimit.fail-open");

    vi.doUnmock("@upstash/redis");
    vi.doUnmock("@upstash/ratelimit");
  });
});
