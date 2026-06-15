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
};

function stubProd(over: Record<string, string> = {}): void {
  vi.stubEnv("NODE_ENV", "production");
  for (const [k, v] of Object.entries({ ...PROD_ENV, ...over })) {
    vi.stubEnv(k, v);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
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
});
