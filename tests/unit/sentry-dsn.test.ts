import { describe, it, expect, afterEach, vi } from "vitest";

import {
  sanitizeDsn,
  resolveSentryDsn,
  sentryIngestOrigin,
  __resetSentryDsnWarning,
} from "@/lib/sentry-dsn";

const DSN = "https://abc123@o456.ingest.us.sentry.io/789";
const ORIGIN = "https://o456.ingest.us.sentry.io";
// A DIFFERENT project, so "which var won" is observable rather than ambiguous.
const BROWSER_DSN = "https://zzz@o999.ingest.us.sentry.io/111";
const BROWSER_ORIGIN = "https://o999.ingest.us.sentry.io";

// U+FEFF. This is not hypothetical: on 2026-07-25 prod's client bundle was found
// to contain `dsn:"﻿https://…"`, i.e. the stored Vercel value itself carried
// a byte-order mark. A BOM survives a paste into a dashboard field, and
// PowerShell's `Out-File`/`>` write UTF-8 WITH a BOM by default.
const BOM_DSN = `﻿${DSN}`;

const ENV_KEYS = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"] as const;
const original = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  __resetSentryDsnWarning();
  vi.restoreAllMocks();
});

describe("sanitizeDsn", () => {
  it("returns null for unset / empty / whitespace-only", () => {
    expect(sanitizeDsn(undefined)).toBeNull();
    expect(sanitizeDsn("")).toBeNull();
    expect(sanitizeDsn("   ")).toBeNull();
  });

  // THE bug. A BOM-prefixed DSN is truthy, so every `Boolean(process.env.SENTRY_DSN)`
  // gate reads "configured" — but `new URL()` throws on it and @sentry/core's DSN
  // parser rejects it, so the SDK initialises enabled-but-dead.
  it("strips a leading U+FEFF BOM (the prod failure)", () => {
    expect(sanitizeDsn(BOM_DSN)).toBe(DSN);
  });

  it("strips ordinary surrounding whitespace and newlines", () => {
    expect(sanitizeDsn(`  ${DSN}\n`)).toBe(DSN);
  });

  it("passes a clean DSN through untouched", () => {
    expect(sanitizeDsn(DSN)).toBe(DSN);
  });

  it("returns null for a value that is not a URL at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeDsn("not-a-dsn")).toBeNull();
  });

  it("warns with a filterable scope instead of failing silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeDsn("not-a-dsn")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toMatchObject({ level: "warn", scope: "sentry.dsn-invalid" });
  });

  it("redacts the offending value — a mistyped var may hold anything", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn("totally-bogus-secret-value-here");
    expect(String(warn.mock.calls[0][0])).not.toContain(
      "totally-bogus-secret-value-here",
    );
  });

  it("warns ONCE, not per request (buildCsp runs on every response)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn("not-a-dsn");
    sanitizeDsn("not-a-dsn");
    sanitizeDsn("not-a-dsn");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when simply unconfigured (unset is not an error)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn(undefined);
    sanitizeDsn("");
    expect(warn).not.toHaveBeenCalled();
  });

  // The latch used to be one process-wide boolean. Both DSN vars are normally
  // pasted from the same clipboard, so "both malformed" is the likely case — and
  // the second one stayed invisible until the first was fixed and redeployed.
  it("warns once PER VAR, so a second bad var is not swallowed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn("not-a-dsn", "SENTRY_DSN");
    sanitizeDsn("also-not-a-dsn", "NEXT_PUBLIC_SENTRY_DSN");
    expect(warn).toHaveBeenCalledTimes(2);
    const vars = warn.mock.calls.map((c) => String(c[0]));
    expect(vars[0]).toContain("SENTRY_DSN");
    expect(vars[1]).toContain("NEXT_PUBLIC_SENTRY_DSN");
  });

  it("still warns only once for the SAME var, however many requests", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn("not-a-dsn", "SENTRY_DSN");
    sanitizeDsn("not-a-dsn", "SENTRY_DSN");
    sanitizeDsn("not-a-dsn", "SENTRY_DSN");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Naming the var must not become a way to leak what is in it.
  it("names the var but still never echoes its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeDsn("totally-bogus-secret-value-here", "NEXT_PUBLIC_SENTRY_DSN");
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("NEXT_PUBLIC_SENTRY_DSN");
    expect(line).not.toContain("totally-bogus-secret-value-here");
  });

  it("surfaces BOTH malformed vars through resolveSentryDsn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SENTRY_DSN = "not-a-dsn";
    process.env.NEXT_PUBLIC_SENTRY_DSN = "also-not-a-dsn";
    expect(resolveSentryDsn()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSentryDsn", () => {
  it("returns null when neither var is set", () => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(resolveSentryDsn()).toBeNull();
  });

  it("prefers SENTRY_DSN when both are set", () => {
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://zzz@o999.ingest.us.sentry.io/111";
    expect(resolveSentryDsn()).toBe(DSN);
  });

  // Only NEXT_PUBLIC_SENTRY_DSN is inlined into the edge/middleware bundle at
  // build time; SENTRY_DSN stays a live process.env read there. The fallback is
  // what gives the edge runtime a usable DSN regardless of what it can read.
  it("falls back to NEXT_PUBLIC_SENTRY_DSN when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
    expect(resolveSentryDsn()).toBe(DSN);
  });

  // `??` (the old lib/csp.ts operator) only falls back on null/undefined, so an
  // empty SENTRY_DSN used to BLOCK the public fallback.
  it("falls back when SENTRY_DSN is set but EMPTY", () => {
    process.env.SENTRY_DSN = "";
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
    expect(resolveSentryDsn()).toBe(DSN);
  });

  it("falls back when SENTRY_DSN is set but unparseable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SENTRY_DSN = "not-a-dsn";
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
    expect(resolveSentryDsn()).toBe(DSN);
  });

  it("sanitizes a BOM off whichever var supplies the value", () => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = BOM_DSN;
    expect(resolveSentryDsn()).toBe(DSN);
  });
});

describe("sentryIngestOrigin", () => {
  it("is null when Sentry is unconfigured", () => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(sentryIngestOrigin()).toBeNull();
  });

  it("returns exactly the ingest origin, never the public key", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.SENTRY_DSN = DSN;
    expect(sentryIngestOrigin()).toBe(ORIGIN);
    expect(sentryIngestOrigin()).not.toContain("abc123");
  });

  it("resolves the origin even from a BOM-prefixed DSN", () => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = BOM_DSN;
    expect(sentryIngestOrigin()).toBe(ORIGIN);
  });

  it("is null (not a throw) for a malformed DSN", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SENTRY_DSN = "not-a-dsn";
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(sentryIngestOrigin()).toBeNull();
  });

  // The preference order here is the OPPOSITE of resolveSentryDsn()'s, on
  // purpose: this origin feeds the CSP connect-src, whose only consumer is the
  // BROWSER SDK — and that is initialised from NEXT_PUBLIC_SENTRY_DSN. If the
  // vars ever point at different projects, preferring SENTRY_DSN would allowlist
  // an origin the browser never contacts and an enforcing CSP would block every
  // real browser event.
  it("prefers NEXT_PUBLIC_SENTRY_DSN — connect-src is for the BROWSER SDK", () => {
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = BROWSER_DSN;
    expect(sentryIngestOrigin()).toBe(BROWSER_ORIGIN);
  });

  it("falls back to SENTRY_DSN when the public var is unset", () => {
    process.env.SENTRY_DSN = DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(sentryIngestOrigin()).toBe(ORIGIN);
  });

  it("falls back to SENTRY_DSN when the public var is set but unparseable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "not-a-dsn";
    expect(sentryIngestOrigin()).toBe(ORIGIN);
  });

  // resolveSentryDsn() keeps the server-first order — only the CSP origin flips.
  it("does not change resolveSentryDsn's server-first preference", () => {
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = BROWSER_DSN;
    expect(resolveSentryDsn()).toBe(DSN);
    expect(sentryIngestOrigin()).toBe(BROWSER_ORIGIN);
  });
});
