import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { NextFetchEvent } from "next/server";
import { getToken } from "next-auth/jwt";

import { proxy } from "@/proxy";

// getToken is the session gate; stub it so we can drive the authed / unauthed
// branches without a real JWT. The rest of proxy (CSP nonce, matcher) is real.
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

function req(path: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy — unauthenticated routing", () => {
  it("returns a JSON 401 for an unauth /api/* route (not a 307 to login HTML)", async () => {
    vi.mocked(getToken).mockResolvedValue(null);
    const res = await proxy(req("/api/native/sign-status"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("redirects an unauth page route to /login (307)", async () => {
    vi.mocked(getToken).mockResolvedValue(null);
    const res = await proxy(req("/signs"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("passes an authenticated /api/* request through", async () => {
    vi.mocked(getToken).mockResolvedValue({ isActive: true } as never);
    const res = await proxy(req("/api/native/sign-status"));
    expect(res.status).toBe(200);
  });
});

// The limiter's module-level state (isConfigured / the Ratelimit instances) is
// resolved at import time, so driving the throttled branch means re-importing
// proxy with a stubbed lib/ratelimit — same shape as ratelimit-failopen.test.ts.
describe("proxy — auth rate limiting", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/ratelimit");
  });

  async function loadProxyWith(checkAuthRateLimit: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("@/lib/ratelimit", () => ({ checkAuthRateLimit }));
    vi.doMock("next-auth/jwt", () => ({ getToken: vi.fn().mockResolvedValue(null) }));
    return (await import("@/proxy")).proxy;
  }

  it("answers 429 with Retry-After once the auth limit is exhausted", async () => {
    const reset = Date.now() + 30_000;
    const check = vi.fn().mockResolvedValue({ success: false, remaining: 0, reset });
    const limited = await loadProxyWith(check);

    const res = await limited(req("/api/auth/signin"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("keys the limiter off the rightmost x-forwarded-for entry, not the spoofable first", async () => {
    const check = vi
      .fn()
      .mockResolvedValue({ success: true, remaining: 9, reset: 0 });
    const limited = await loadProxyWith(check);

    await limited(req("/api/auth/signin", { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(check).toHaveBeenCalledWith("203.0.113.9");
  });

  it("does not spend auth budget on a non-auth path", async () => {
    const check = vi
      .fn()
      .mockResolvedValue({ success: true, remaining: 9, reset: 0 });
    const limited = await loadProxyWith(check);

    await limited(req("/signs"));
    expect(check).not.toHaveBeenCalled();
  });
});

// #272: proxy.ts is the edge auth gate + rate limiter — the highest-traffic code
// in the app and the one whose failure is most total — and it had ZERO logError
// calls. With the edge Sentry SDK also disabled on prod, a throw here produced no
// signal anywhere: no Sentry event, no structured stderr line to filter by scope.
describe("proxy — failure instrumentation (#272)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/log");
    vi.doUnmock("@/lib/csp");
    vi.doUnmock("@/lib/ratelimit");
    vi.doUnmock("next-auth/jwt");
    vi.doUnmock("@sentry/nextjs");
  });

  async function loadProxy(opts: {
    getToken?: ReturnType<typeof vi.fn>;
    checkAuthRateLimit?: ReturnType<typeof vi.fn>;
    buildCspThrows?: boolean;
    flushRejects?: boolean;
  }) {
    vi.resetModules();
    const logError = vi.fn();
    vi.doMock("@/lib/log", () => ({ logError, logWarn: vi.fn() }));
    if (opts.flushRejects) {
      vi.doMock("@sentry/nextjs", () => ({
        flush: vi.fn().mockRejectedValue(new Error("flush boom")),
      }));
    }
    vi.doMock("next-auth/jwt", () => ({
      getToken: opts.getToken ?? vi.fn().mockResolvedValue({ isActive: true }),
    }));
    if (opts.checkAuthRateLimit) {
      vi.doMock("@/lib/ratelimit", () => ({
        checkAuthRateLimit: opts.checkAuthRateLimit,
      }));
    }
    if (opts.buildCspThrows) {
      vi.doMock("@/lib/csp", () => ({
        generateNonce: () => "nonce",
        buildCsp: () => {
          throw new Error("csp boom");
        },
        resolveCspMode: () => "report" as const,
        cspResponseHeaderName: () => "Content-Security-Policy-Report-Only",
      }));
    }
    return { proxy: (await import("@/proxy")).proxy, logError };
  }

  // SECURITY: the auth gate fails CLOSED. A gate that could not establish a
  // session must never pass the request through as if it had.
  it("fails CLOSED to a 401 for /api/* when the session lookup throws", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p, logError } = await loadProxy({ getToken });

    const res = await p(req("/api/native/sign-status"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(logError).toHaveBeenCalledWith(
      "proxy",
      expect.any(Error),
      expect.objectContaining({ pathname: "/api/native/sign-status" }),
    );
  });

  it("fails CLOSED to the login redirect for a page when the session lookup throws", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p, logError } = await loadProxy({ getToken });

    const res = await p(req("/signs"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(logError).toHaveBeenCalled();
  });

  it("never passes an unauthenticated request through on error", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p } = await loadProxy({ getToken });

    const res = await p(req("/signs"));
    expect(res.status).not.toBe(200);
  });

  // A public path must NOT be "failed closed" by redirecting to /login — /login
  // is itself public, so that would be an infinite redirect loop. It degrades to
  // a deliberate 503 instead.
  it("answers 503 (not a redirect loop) when a PUBLIC path fails", async () => {
    const { proxy: p, logError } = await loadProxy({ buildCspThrows: true });

    const res = await p(req("/login"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(logError).toHaveBeenCalled();
  });

  // The limiter is the ONE place that fails open, matching lib/ratelimit.ts's
  // documented posture: an Upstash blip must not 503 the con floor.
  it("fails OPEN and logs when the rate limiter throws", async () => {
    const checkAuthRateLimit = vi.fn().mockRejectedValue(new Error("upstash down"));
    const { proxy: p, logError } = await loadProxy({ checkAuthRateLimit });

    const res = await p(req("/api/auth/signin"));
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(503);
    expect(logError).toHaveBeenCalledWith(
      "proxy.ratelimit",
      expect.any(Error),
      expect.objectContaining({ pathname: "/api/auth/signin" }),
    );
  });

  it("stays silent on the happy path (no log noise per request)", async () => {
    const { proxy: p, logError } = await loadProxy({});
    await p(req("/signs"));
    expect(logError).not.toHaveBeenCalled();
  });

  // proxy.ts runs on nearly every request. A persistent fault (bad deploy) would
  // otherwise emit one stderr line + one Sentry event PER REQUEST — burning the
  // quota that the team needs to see the incident at all, and handing an attacker
  // a cheap amplifier.
  it("throttles repeated failures instead of logging one per request", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p, logError } = await loadProxy({ getToken });

    for (let i = 0; i < 25; i++) await p(req("/signs"));

    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("still fails closed on every throttled request, not just the logged one", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p } = await loadProxy({ getToken });

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await p(req("/signs"))).status);

    expect(statuses).toEqual([307, 307, 307, 307, 307]);
  });

  // Throttling must never make the suppression itself invisible.
  it("reports how many failures it suppressed on the next line through", async () => {
    vi.useFakeTimers();
    try {
      const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
      const { proxy: p, logError } = await loadProxy({ getToken });

      await p(req("/signs")); // logged — opens the window
      await p(req("/signs")); // suppressed
      await p(req("/signs")); // suppressed
      vi.advanceTimersByTime(11_000); // window expires
      await p(req("/signs")); // logged, carrying the count

      expect(logError).toHaveBeenCalledTimes(2);
      expect(logError.mock.calls[1][2]).toMatchObject({ suppressed: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  // Every other case in this file calls proxy(req) with no NextFetchEvent, so
  // `event?.waitUntil(...)` optional-chains away and the flush path is never
  // exercised. Next always passes the event in production, and without the
  // waitUntil the edge isolate can be frozen the moment the response returns —
  // the stderr line survives and the Sentry event silently does not.
  //
  // The mock settles the promise itself, standing in for the platform: the point
  // under test is that proxy hands the flush off and returns without awaiting it.
  function fetchEventStub() {
    const waitUntil = vi.fn((p: unknown) => {
      void Promise.resolve(p).catch(() => {});
    });
    return { event: { waitUntil } as unknown as NextFetchEvent, waitUntil };
  }

  it("hands the Sentry flush to waitUntil when Next passes the fetch event", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p } = await loadProxy({ getToken });
    const { event, waitUntil } = fetchEventStub();

    const res = await p(req("/signs"), event);
    expect(res.status).toBe(307);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  // Observability must never break the request path: a Sentry transport that
  // cannot reach the ingest endpoint still has to leave the gate answering.
  it("still answers normally when the flush promise rejects", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p, logError } = await loadProxy({ getToken, flushRejects: true });
    const { event, waitUntil } = fetchEventStub();

    const res = await p(req("/api/native/sign-status"), event);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();
  });

  it("throttles the rate-limiter scope separately from the auth scope", async () => {
    const checkAuthRateLimit = vi.fn().mockRejectedValue(new Error("upstash down"));
    const getToken = vi.fn().mockRejectedValue(new Error("jwt boom"));
    const { proxy: p, logError } = await loadProxy({ getToken, checkAuthRateLimit });

    await p(req("/api/auth/signin")); // hits proxy.ratelimit only (public path)
    await p(req("/signs")); // hits proxy

    const scopes = logError.mock.calls.map((c) => c[0]);
    expect(scopes).toContain("proxy.ratelimit");
    expect(scopes).toContain("proxy");
  });
});
