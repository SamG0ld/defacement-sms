// Single source of truth for "which Sentry DSN can THIS runtime actually use".
// Every Sentry entry point (server, edge, browser) and lib/csp.ts reads through
// here so they can't disagree about whether Sentry is configured.
//
// Two things silently broke prod observability; both are handled here.
//
// 1. A DSN value can carry a leading U+FEFF byte-order mark. Measured on prod
//    2026-07-25: the client bundle contained `dsn:"﻿https://…"`, i.e. the
//    stored Vercel value itself began with a BOM. (A BOM survives a paste into a
//    dashboard field, and PowerShell's `Out-File` / `>` write UTF-8 WITH a BOM by
//    default — the likeliest origin.) That value is *truthy*, so every
//    `Boolean(process.env.SENTRY_DSN)` gate reads "configured" — but `new URL()`
//    throws on it and @sentry/core's DSN parser rejects it outright. The result
//    was an SDK initialised `enabled: true` with no usable DSN (silently dropping
//    every event) and a CSP whose Sentry ingest origin vanished. `trim()` strips
//    U+FEFF (it is WhiteSpace per the spec), so sanitising at read time makes the
//    app behave correctly even against a corrupt stored value — no dashboard fix
//    required for it to work.
//
// 2. Only `NEXT_PUBLIC_SENTRY_DSN` is inlined into the edge/middleware bundle at
//    build time; `SENTRY_DSN` stays a live `process.env` read there. Verified by
//    building with sentinel values and reading the compiled chunk that
//    .next/server/middleware.js loads. Preferring SENTRY_DSN but FALLING BACK to
//    the public var means the edge runtime always has a usable DSN regardless of
//    what it can read at runtime.
//
// Imports nothing, deliberately: lib/csp.ts is edge-pure (see its header) and
// pulls this in, so any dependency here would land in the middleware bundle.

// Warn once per ENV VAR, not per request — buildCsp() runs on every response.
// Mirrors the `warnedBadMode` latch in lib/csp.ts, but keyed rather than a
// single boolean: the two DSN vars are normally pasted from the same clipboard,
// so "both are malformed" is the likely case, and a process-wide latch meant the
// second one stayed invisible until the first was fixed and redeployed.
const warnedInvalid = new Set<string>();

/** Test-only: reset the warn-once latch between cases. */
export function __resetSentryDsnWarning(): void {
  warnedInvalid.clear();
}

// Never echo a misconfigured value: the var may hold anything, including a
// credential pasted into the wrong field, and this line reaches both stderr and
// Sentry (console breadcrumbs). A raw prefix would fingerprint the credential
// TYPE (`sk-pro`, `ghp_ab`, `xoxb-a`), so report only the URL scheme — enough to
// tell "this isn't a DSN" from "this is the wrong DSN" — plus the length.
function redact(value: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(value)?.[0] ?? "(no scheme)";
  return `${scheme}… ${value.length} chars`;
}

/**
 * Trim + validate one raw env value. Returns the cleaned DSN, or null when it is
 * unset/empty (not an error) or unparseable (an error — warned, never swallowed).
 *
 * `varName` is the environment variable the value came from. It is used to key
 * the warn-once latch (so a second, distinct bad var still surfaces) and named
 * in the warning so the operator knows which one to re-enter. It is a NAME, not
 * a value — nothing sensitive.
 */
export function sanitizeDsn(
  raw: string | undefined | null,
  varName?: string,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    new URL(trimmed);
  } catch {
    // The bug this module exists to prevent was a bare `catch { return null }`
    // in lib/csp.ts: a broken DSN looked exactly like an unconfigured one, so
    // the failure was invisible for as long as nobody diffed a CSP header.
    // Latch on the var name when the caller knows it; otherwise on the REDACTED
    // descriptor, so an anonymous call still can't spam per request but a
    // genuinely different bad value is never swallowed by an earlier one.
    const latchKey = varName ?? redact(trimmed);
    if (!warnedInvalid.has(latchKey)) {
      warnedInvalid.add(latchKey);
      console.warn(
        JSON.stringify({
          level: "warn",
          scope: "sentry.dsn-invalid",
          message:
            `${varName ?? "A Sentry DSN"} is set but is not a valid URL ` +
            `(${redact(trimmed)}) — Sentry is DISABLED for this runtime. ` +
            "Re-enter the DSN; a stray byte-order mark or quote character is " +
            "the usual cause.",
        }),
      );
    }
    return null;
  }
  return trimmed;
}

/**
 * The DSN this runtime should use: `SENTRY_DSN` when usable, else the
 * build-inlined `NEXT_PUBLIC_SENTRY_DSN`.
 *
 * Not `SENTRY_DSN ?? NEXT_PUBLIC_SENTRY_DSN` (the previous lib/csp.ts form):
 * `??` falls back only on null/undefined, so an EMPTY `SENTRY_DSN` used to block
 * the public fallback entirely. Chaining through sanitizeDsn also means a
 * malformed server DSN degrades to the browser one instead of disabling Sentry.
 *
 * Both reads are literal `process.env.X` member expressions so Next's build-time
 * inlining of `NEXT_PUBLIC_*` still applies from this shared module.
 */
export function resolveSentryDsn(): string | null {
  return (
    sanitizeDsn(process.env.SENTRY_DSN, "SENTRY_DSN") ??
    sanitizeDsn(process.env.NEXT_PUBLIC_SENTRY_DSN, "NEXT_PUBLIC_SENTRY_DSN")
  );
}

/**
 * The origin the browser SDK POSTs events to, for the CSP `connect-src`
 * allowlist — origin only, never the DSN's public key.
 *
 * The preference order here is deliberately the OPPOSITE of resolveSentryDsn().
 * This origin exists for exactly one consumer — the BROWSER SDK, which
 * instrumentation-client.ts initialises from NEXT_PUBLIC_SENTRY_DSN. If the two
 * vars ever point at different Sentry projects, preferring SENTRY_DSN would
 * allowlist an origin the browser never contacts and, under an enforcing CSP,
 * block every real browser event. Server/edge events don't go through the CSP at
 * all, so they have no stake in the choice.
 */
export function sentryIngestOrigin(): string | null {
  const dsn =
    sanitizeDsn(process.env.NEXT_PUBLIC_SENTRY_DSN, "NEXT_PUBLIC_SENTRY_DSN") ??
    sanitizeDsn(process.env.SENTRY_DSN, "SENTRY_DSN");
  // Safe without a guard: sanitizeDsn only returns values that already parsed.
  // Anything unexpected surfaces via proxy.ts's handler rather than being
  // swallowed here.
  return dsn ? new URL(dsn).origin : null;
}
