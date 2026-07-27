import { describe, it, expect, afterEach, vi } from "vitest";

import {
  buildCsp,
  cspResponseHeaderName,
  generateNonce,
  resolveCspMode,
  __resetCspModeWarning,
} from "@/lib/csp";
import { __resetSentryDsnWarning } from "@/lib/sentry-dsn";

// Pull the script-src / style-src directive out of a CSP string for assertions.
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
}

describe("generateNonce", () => {
  it("is URL-safe base64 with no padding", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateNonce()).not.toMatch(/[+/=]/);
    }
  });

  it("is 22 chars (base64url of 16 random bytes)", () => {
    expect(generateNonce()).toHaveLength(22);
  });

  it("is unique per call (128-bit entropy)", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });
});

describe("buildCsp", () => {
  it("puts the per-request nonce in script-src", () => {
    const nonce = generateNonce();
    expect(directive(buildCsp(nonce), "script-src")).toContain(`'nonce-${nonce}'`);
  });

  it("uses 'strict-dynamic' and drops 'unsafe-inline' from script-src", () => {
    const scriptSrc = directive(buildCsp(generateNonce()), "script-src");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("keeps 'unsafe-inline' in style-src (Tailwind v4 critical CSS)", () => {
    expect(directive(buildCsp(generateNonce()), "style-src")).toContain(
      "'unsafe-inline'",
    );
  });

  it("locks down framing and plugin embeds", () => {
    const csp = buildCsp(generateNonce());
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("wires CSP violation reporting (report-to + report-uri)", () => {
    const csp = buildCsp(generateNonce());
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});

describe("buildCsp connect-src (Sentry)", () => {
  const origDsn = process.env.SENTRY_DSN;
  const origPublic = process.env.NEXT_PUBLIC_SENTRY_DSN;
  afterEach(() => {
    if (origDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = origDsn;
    if (origPublic === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = origPublic;
    __resetSentryDsnWarning();
    vi.restoreAllMocks();
  });

  it("allows only 'self' + Google when Sentry is unconfigured", () => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(directive(buildCsp(generateNonce()), "connect-src")).toBe(
      "connect-src 'self' https://accounts.google.com",
    );
  });

  it("adds exactly the DSN's ingest origin when configured", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.SENTRY_DSN = "https://abc123@o456.ingest.us.sentry.io/789";
    const connect = directive(buildCsp(generateNonce()), "connect-src");
    expect(connect).toBe(
      "connect-src 'self' https://accounts.google.com https://o456.ingest.us.sentry.io",
    );
    expect(connect).not.toContain("abc123");
  });

  // #271/#272 root cause, measured on prod 2026-07-25: the stored
  // NEXT_PUBLIC_SENTRY_DSN carried a leading U+FEFF BOM. `new URL()` throws on
  // that, the old bare `catch` swallowed the throw, and the ingest origin
  // silently vanished from connect-src — which is the observation both issues
  // read as "the edge runtime cannot see the DSN".
  it("tolerates a BOM-prefixed DSN (the prod failure)", () => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "﻿https://abc123@o456.ingest.us.sentry.io/789";
    expect(directive(buildCsp(generateNonce()), "connect-src")).toBe(
      "connect-src 'self' https://accounts.google.com https://o456.ingest.us.sentry.io",
    );
  });

  // Only NEXT_PUBLIC_SENTRY_DSN is build-inlined into the middleware bundle, so
  // this fallback is what the edge runtime actually relies on.
  it("falls back to NEXT_PUBLIC_SENTRY_DSN when SENTRY_DSN is empty", () => {
    process.env.SENTRY_DSN = "";
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://abc123@o456.ingest.us.sentry.io/789";
    expect(directive(buildCsp(generateNonce()), "connect-src")).toContain(
      "https://o456.ingest.us.sentry.io",
    );
  });

  it("omits the origin and warns (not silently) on a malformed DSN", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SENTRY_DSN = "not-a-dsn";
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(directive(buildCsp(generateNonce()), "connect-src")).toBe(
      "connect-src 'self' https://accounts.google.com",
    );
    expect(warn).toHaveBeenCalled();
  });
});

describe("resolveCspMode / cspResponseHeaderName", () => {
  const original = process.env.CSP_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.CSP_MODE;
    else process.env.CSP_MODE = original;
    __resetCspModeWarning();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("maps each mode to the correct response header name", () => {
    expect(cspResponseHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspResponseHeaderName("report")).toBe(
      "Content-Security-Policy-Report-Only",
    );
  });

  it("resolves to a valid mode by default", () => {
    expect(["enforce", "report"]).toContain(resolveCspMode());
  });

  it("CSP_MODE=enforce overrides NODE_ENV", () => {
    process.env.CSP_MODE = "enforce";
    expect(resolveCspMode()).toBe("enforce");
  });

  it("CSP_MODE=report overrides NODE_ENV", () => {
    process.env.CSP_MODE = "report";
    expect(resolveCspMode()).toBe("report");
  });

  it("an unrecognized CSP_MODE falls back to report", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "bogus";
    expect(resolveCspMode()).toBe("report");
  });
});

// #247: the fallback direction is the LESS safe one (anything but the exact
// string "enforce" → report-only), so a stray value must be loud, and an EMPTY
// value must not count as a value at all.
describe("resolveCspMode — unset vs empty vs unrecognized (#247)", () => {
  const original = process.env.CSP_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.CSP_MODE;
    else process.env.CSP_MODE = original;
    __resetCspModeWarning();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // .env.example ships `CSP_MODE=""`. `??` only falls back on null/undefined, so
  // before the fix that empty string resolved to report-only IN PRODUCTION —
  // the documented example value silently disabling enforcement.
  it("treats an empty CSP_MODE as unset (production still enforces)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    process.env.CSP_MODE = "";
    expect(resolveCspMode()).toBe("enforce");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only CSP_MODE as unset", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    process.env.CSP_MODE = "   ";
    expect(resolveCspMode()).toBe("enforce");
  });

  it("still defaults to report outside production when unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.CSP_MODE;
    expect(resolveCspMode()).toBe("report");
  });

  it("accepts surrounding whitespace around a real mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "  enforce  ";
    expect(resolveCspMode()).toBe("enforce");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with a filterable scope when CSP_MODE is unrecognized", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "enforced"; // the realistic typo
    expect(resolveCspMode()).toBe("report");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toMatchObject({ level: "warn", scope: "csp.mode-unrecognized" });
    expect(line.message).toContain("enforced");
  });

  it("is case-sensitive — 'Enforce' is unrecognized, not a silent pass", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "Enforce";
    expect(resolveCspMode()).toBe("report");
  });

  it("warns ONCE, not on every request (proxy.ts resolves per module load)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "true";
    resolveCspMode();
    resolveCspMode();
    resolveCspMode();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never leaks the bad value into the resolved mode", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSP_MODE = "report-only";
    expect(["enforce", "report"]).toContain(resolveCspMode());
  });
});
