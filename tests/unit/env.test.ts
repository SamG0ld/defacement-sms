import { describe, it, expect, afterEach, vi } from "vitest";

import { assertProdEnv } from "@/lib/env";

const STRONG_SECRET = "f3Zb9q1KX0mP7wRtY5uIoA2sDfGhJkLz"; // 32 chars

const PROD_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://example",
  AUTH_SECRET: STRONG_SECRET,
  AUTH_GOOGLE_ID: "id",
  AUTH_GOOGLE_SECRET: "secret",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  AUTH_RESEND_KEY: "re_key",
  EMAIL_FROM: "x <noreply@example.com>",
  BLOB_READ_WRITE_TOKEN: "blob_token",
  // Pinned rather than inherited: the Sentry DSN requirement below is gated on
  // BOTH of these, so leaving them ambient would make every case in this file
  // depend on the shell it ran in.
  VERCEL: "",
  NEXT_RUNTIME: "",
};

function stubProd(over: Record<string, string> = {}): void {
  vi.stubEnv("NODE_ENV", "production");
  for (const [k, v] of Object.entries({ ...PROD_ENV, ...over })) {
    vi.stubEnv(k, v);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("assertProdEnv", () => {
  it("is a no-op outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("passes with a full, strong production config", () => {
    stubProd();
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("names the missing variables", () => {
    // Both blob credentials absent so the either/or branch reports it
    // deterministically (independent of any ambient BLOB_STORE_ID).
    stubProd({ BLOB_READ_WRITE_TOKEN: "", BLOB_STORE_ID: "" });
    expect(() => assertProdEnv()).toThrow(/BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID/);
  });

  it("accepts OIDC blob auth (BLOB_STORE_ID) without a static token", () => {
    stubProd({ BLOB_READ_WRITE_TOKEN: "", BLOB_STORE_ID: "store_abc123" });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("rejects the .env.example placeholder secret", () => {
    stubProd({ AUTH_SECRET: "change-me" });
    expect(() => assertProdEnv()).toThrow(/AUTH_SECRET/);
  });

  it("rejects a secret shorter than 32 characters", () => {
    stubProd({ AUTH_SECRET: "short-but-not-the-placeholder" });
    expect(() => assertProdEnv()).toThrow(/AUTH_SECRET/);
  });

  it("requires Upstash in production by default", () => {
    stubProd({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
    expect(() => assertProdEnv()).toThrow(/UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN/);
  });

  it("skips the Upstash requirement when RATELIMIT_OPTIONAL is set (staging)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubProd({
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      RATELIMIT_OPTIONAL: "1",
      VERCEL: "",
    });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("RATELIMIT_OPTIONAL relaxes only Upstash, not the other required vars", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubProd({
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      RATELIMIT_OPTIONAL: "1",
      AUTH_RESEND_KEY: "",
      VERCEL: "",
    });
    expect(() => assertProdEnv()).toThrow(/AUTH_RESEND_KEY/);
  });

  it("refuses RATELIMIT_OPTIONAL on Vercel (real prod platform)", () => {
    stubProd({
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      RATELIMIT_OPTIONAL: "1",
      VERCEL: "1",
    });
    expect(() => assertProdEnv()).toThrow(/must never be set on Vercel/);
  });
});

// #271. PR #270 added this requirement WITHOUT a runtime scope and was closed
// unmerged: assertProdEnv() is called from instrumentation.ts's register() in
// EVERY runtime, and proxy.ts — the edge auth gate + rate limiter — lives in the
// edge one. A throw there fails every route the middleware matches, so a guard
// meant to protect observability would itself have been a total prod outage.
// #270's suite had three passing Sentry cases and not one of them was the edge.
describe("assertProdEnv — Sentry DSN requirement is runtime-scoped (#271)", () => {
  const DSN = "https://abc123@o456.ingest.us.sentry.io/789";
  const BOTH = { SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN: DSN };

  // The load-bearing case: the one that would have taken prod down.
  it("does NOT throw in the edge runtime, even with both DSNs unreadable", () => {
    stubProd({ VERCEL: "1", NEXT_RUNTIME: "edge" });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("still enforces the NON-Sentry prod vars in the edge runtime", () => {
    stubProd({ VERCEL: "1", NEXT_RUNTIME: "edge", AUTH_SECRET: "change-me" });
    expect(() => assertProdEnv()).toThrow(/AUTH_SECRET/);
  });

  it("requires both DSNs in the node runtime on Vercel", () => {
    stubProd({ VERCEL: "1", NEXT_RUNTIME: "nodejs" });
    expect(() => assertProdEnv()).toThrow(/SENTRY_DSN/);
    expect(() => assertProdEnv()).toThrow(/NEXT_PUBLIC_SENTRY_DSN/);
  });

  // Scoped as `!== "edge"`, not `=== "nodejs"`. Next inlines
  // `process.env.NEXT_RUNTIME` as a build-time literal, so in a shipped bundle
  // the two predicates behave identically and the unset state is not reachable —
  // this case pins the DEFENSIVE shape rather than a specific runtime behaviour:
  // a runtime the bundler doesn't inline must still fail closed, not skip.
  it("requires them when NEXT_RUNTIME is unset (fails closed, defensively)", () => {
    stubProd({ VERCEL: "1" });
    expect(() => assertProdEnv()).toThrow(/SENTRY_DSN/);
  });

  it("passes on Vercel/node when both DSNs are set", () => {
    stubProd({ VERCEL: "1", NEXT_RUNTIME: "nodejs", ...BOTH });
    expect(() => assertProdEnv()).not.toThrow();
  });

  // A BOM-prefixed DSN is what prod actually had. It is recoverable (trimmed at
  // read time), so it must NOT be treated as a missing var and crash the deploy.
  it("accepts a BOM-prefixed DSN rather than failing the deploy over it", () => {
    stubProd({
      VERCEL: "1",
      NEXT_RUNTIME: "nodejs",
      SENTRY_DSN: `﻿${DSN}`,
      NEXT_PUBLIC_SENTRY_DSN: `﻿${DSN}`,
    });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("rejects a DSN that is present but unparseable, naming the var", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubProd({
      VERCEL: "1",
      NEXT_RUNTIME: "nodejs",
      SENTRY_DSN: "not-a-dsn",
      NEXT_PUBLIC_SENTRY_DSN: DSN,
    });
    expect(() => assertProdEnv()).toThrow(/SENTRY_DSN/);
  });

  it("names only the browser var when only that one is missing", () => {
    stubProd({ VERCEL: "1", NEXT_RUNTIME: "nodejs", SENTRY_DSN: DSN });
    expect(() => assertProdEnv()).toThrow(/NEXT_PUBLIC_SENTRY_DSN/);
  });

  // A self-hosted deploy legitimately runs without Sentry — same
  // carve-out shape as RATELIMIT_OPTIONAL above.
  it("does not require Sentry off Vercel, in any runtime", () => {
    stubProd({ VERCEL: "", NEXT_RUNTIME: "nodejs" });
    expect(() => assertProdEnv()).not.toThrow();
  });
});

// #247: resolveCspMode() fails OPEN — anything but the exact string "enforce"
// degrades to report-only. The runtime warn-once is the observability half; this
// is the loud half, so a typo in a deploy's env crashes startup instead of
// quietly shipping production with CSP enforcement off.
describe("assertProdEnv — CSP_MODE validation (#247)", () => {
  it("accepts CSP_MODE=enforce", () => {
    stubProd({ CSP_MODE: "enforce" });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("accepts CSP_MODE=report (the pre-flip deploy state)", () => {
    stubProd({ CSP_MODE: "report" });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("accepts an unset CSP_MODE (production defaults to enforce)", () => {
    stubProd();
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("accepts an empty CSP_MODE — .env.example ships CSP_MODE=\"\"", () => {
    stubProd({ CSP_MODE: "" });
    expect(() => assertProdEnv()).not.toThrow();
  });

  it("rejects a typo'd CSP_MODE, naming the offending value", () => {
    stubProd({ CSP_MODE: "enforced" });
    expect(() => assertProdEnv()).toThrow(/CSP_MODE/);
    expect(() => assertProdEnv()).toThrow(/enforced/);
  });

  it("rejects a wrong-case CSP_MODE (resolveCspMode is case-sensitive)", () => {
    stubProd({ CSP_MODE: "Enforce" });
    expect(() => assertProdEnv()).toThrow(/CSP_MODE/);
  });

  it("rejects truthy-looking values that would silently mean report-only", () => {
    for (const value of ["1", "true", "on", "yes"]) {
      stubProd({ CSP_MODE: value });
      expect(() => assertProdEnv()).toThrow(/CSP_MODE/);
    }
  });

  it("is a no-op outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CSP_MODE", "bogus");
    expect(() => assertProdEnv()).not.toThrow();
  });
});
