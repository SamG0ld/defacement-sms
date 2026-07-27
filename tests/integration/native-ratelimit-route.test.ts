// #84: the native rate-limit ENFORCEMENT path had no test — a regression that
// broke it (wrong key/window/threshold, or a removed check) was invisible to the
// suite. requireApiSession() calls checkNativeRateLimit() for every /api/native/*
// call and throws 429 when it rejects; this proves that wire-up end-to-end by
// stubbing the limiter (the real one fails OPEN with no Upstash, so it can't be
// exercised otherwise).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ checkNativeRateLimit: vi.fn() }));

import { auth } from "@/lib/auth";
import { checkNativeRateLimit } from "@/lib/ratelimit";
import { POST } from "@/app/api/native/deploys/route";

function deploysPost(body: unknown) {
  return POST(
    new Request("http://localhost/api/native/deploys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  // An active, authenticated user — so the only gate under test is the limiter.
  vi.mocked(auth).mockResolvedValue({
    user: { id: "u1", email: "u1@example.com", role: "volunteer", isActive: true },
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("native rate limit — requireApiSession enforcement (#84)", () => {
  it("returns 429 when the limiter rejects the request", async () => {
    vi.mocked(checkNativeRateLimit).mockResolvedValue({
      success: false,
      remaining: 0,
      reset: 0,
    });
    const res = await deploysPost({ events: [] });
    expect(res.status).toBe(429);
  });

  it("lets the request past the limiter when it allows it", async () => {
    vi.mocked(checkNativeRateLimit).mockResolvedValue({
      success: true,
      remaining: 99,
      reset: 0,
    });
    // Past the limiter, a malformed body fails schema validation (400) — which
    // proves the limiter did NOT block and the request reached the handler body.
    const res = await deploysPost({ events: "bad" });
    expect(res.status).toBe(400);
    // Pin that the (stubbed) limiter was actually consulted — without this the
    // test would pass even if the mock never applied (the real limiter fails OPEN
    // with no Upstash, also yielding 400 on the bad body).
    expect(vi.mocked(checkNativeRateLimit)).toHaveBeenCalledTimes(1);
  });
});
