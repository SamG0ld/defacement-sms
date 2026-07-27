import { sanitizeDsn } from "./sentry-dsn";

// Production env preflight. In production, missing critical config should fail
// loudly at server startup rather than silently degrade — e.g. the rate limiter
// (lib/ratelimit.ts) otherwise disables itself when Upstash vars are absent,
// removing brute-force protection on /api/auth with no signal. No-op outside
// production so local dev stays zero-config.
const REQUIRED_PROD_ENV = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  // Magic-link email (Resend). Required in prod so a misconfigured deploy fails
  // loud rather than silently leaving teammates who can't use Google OAuth
  // without a way in.
  "AUTH_RESEND_KEY",
  "EMAIL_FROM",
] as const;

// Upstash powers the rate limiter (lib/ratelimit.ts), which fails open when its
// vars are absent. They're in REQUIRED_PROD_ENV so a real production deploy can't
// silently ship with brute-force protection off. A self-hosted *staging* box that
// deliberately runs without Upstash may set RATELIMIT_OPTIONAL=1 to skip ONLY this
// pair (the limiter then fails open). NEVER set it in production — assertProdEnv
// hard-throws if it's set on Vercel, and warns loudly otherwise.
const RATELIMIT_ENV_KEYS: ReadonlySet<string> = new Set([
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]);

export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  // Explicit "1" only (the value .env.example documents) so a stray
  // "0"/"false" can't accidentally enable the hatch.
  const rateLimitOptional = process.env.RATELIMIT_OPTIONAL === "1";
  // Structural guard: this hatch is self-hosted-staging-only. Vercel always sets
  // VERCEL=1, so refuse it there — a leaked flag crashes the deploy loudly (and
  // surfaces in Sentry via the startup error) instead of silently shipping prod
  // with brute-force protection off.
  if (rateLimitOptional && process.env.VERCEL) {
    throw new Error(
      "RATELIMIT_OPTIONAL must never be set on Vercel/production — it is a " +
        "self-hosted-staging-only escape hatch that waives the Upstash requirement.",
    );
  }
  if (rateLimitOptional) {
    console.warn(
      "[env] RATELIMIT_OPTIONAL is set: Upstash rate limiting is DISABLED (env " +
        "check waived); the limiter will fail open. Staging/self-hosted only — " +
        "never set this in production.",
    );
  }

  const required = rateLimitOptional
    ? REQUIRED_PROD_ENV.filter((key) => !RATELIMIT_ENV_KEYS.has(key))
    : REQUIRED_PROD_ENV;
  const missing: string[] = required.filter((key) => !process.env[key]);
  // Vercel Blob (deploy/sign photos, lib/blob-image.ts) authenticates with EITHER
  // a static read-write token OR OIDC (BLOB_STORE_ID + the platform-injected,
  // auto-rotated VERCEL_OIDC_TOKEN). Connecting a store via "Connect to Project"
  // provisions OIDC (BLOB_STORE_ID), not BLOB_READ_WRITE_TOKEN — and the app only
  // does server-side put/get/del, which OIDC fully supports. Require either, so a
  // deploy with no blob credential still fails loudly, but an OIDC-connected
  // store isn't rejected for lacking the legacy static token.
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    missing.push("BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
  // AUTH_SECRET signs every session JWT — a guessable value forges sessions, so
  // presence alone isn't enough: reject the .env.example placeholder and
  // anything shorter than the 32 chars `openssl rand -base64 32` produces.
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret === "change-me" || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET is too weak for production (placeholder or under 32 chars). " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  // resolveCspMode() (lib/csp.ts) fails OPEN: any value that isn't exactly
  // "enforce" degrades to report-only, in production, and the app looks and
  // behaves identically — so a typo could disable CSP enforcement indefinitely
  // (#247). Reject it here so the deploy crashes loudly instead. Unset/empty is
  // legal: that's "use the NODE_ENV default", which is enforce in production.
  const cspMode = process.env.CSP_MODE?.trim();
  if (cspMode && cspMode !== "enforce" && cspMode !== "report") {
    throw new Error(
      `CSP_MODE="${cspMode}" is invalid — it must be exactly "enforce" or ` +
        '"report" (or unset for the default). Any other value silently ' +
        "downgrades production to report-only, disabling CSP enforcement.",
    );
  }

  // Observability: on Vercel, a real production/preview deploy must ship with a
  // USABLE Sentry DSN for both halves — SENTRY_DSN (server + edge) and
  // NEXT_PUBLIC_SENTRY_DSN (browser, inlined at build) — since either being
  // absent makes that half a no-op with no signal. Gated on VERCEL (not NODE_ENV
  // alone) so a self-hosted staging box that legitimately runs without Sentry
  // isn't forced to set it, mirroring the RATELIMIT_OPTIONAL carve-out above.
  //
  // Deliberately LAST: this is an observability requirement, and throwing it
  // ahead of the AUTH_SECRET / CSP_MODE checks above would mask a security
  // misconfiguration behind a monitoring one — the operator would fix the DSN,
  // redeploy, and only then learn the secret was weak.
  //
  // #271 — WHY THIS IS RUNTIME-SCOPED, and why the scope is `!== "edge"`:
  // assertProdEnv() is called from instrumentation.ts's register(), which Next
  // runs once per runtime — including the EDGE runtime, where proxy.ts (the auth
  // gate + rate limiter) lives. PR #270 added this check unscoped; a throw in the
  // edge register() fails every route the middleware matches, so the guard meant
  // to protect observability would itself have been a total prod outage.
  // Scoped as "not edge" rather than "=== nodejs" deliberately, though for a
  // weaker reason than an earlier version of this comment claimed: Next
  // substitutes `process.env.NEXT_RUNTIME` as a BUILD-TIME literal
  // (next/dist/build/define-env.js), so in a shipped artifact there is no
  // reachable "unset" state for either predicate to differ on. "Not edge" is
  // kept as the defensive shape — it fails CLOSED on any runtime the bundler
  // does not inline, and opens only on the one runtime a throw would take down.
  // NOTE this keys on the RUNTIME, not on "is this proxy.ts" (Next exposes no
  // such signal) — proxy.ts is the only edge entry point today, so if a route
  // ever adds `export const runtime = "edge"` it will silently skip this too.
  //
  // Validity, not just presence: a DSN carrying a stray BOM is truthy but
  // unparseable (see lib/sentry-dsn.ts) — the failure mode this pair was actually
  // in on 2026-07-25. A recoverable BOM is trimmed at read time and passes here.
  if (process.env.VERCEL && process.env.NEXT_RUNTIME !== "edge") {
    const sentryProblems = (
      ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"] as const
    ).flatMap((key) => {
      const raw = process.env[key];
      if (!raw?.trim()) return [`${key} (unset)`];
      return sanitizeDsn(raw, key)
        ? []
        : [`${key} (set, but not a valid DSN URL)`];
    });
    if (sentryProblems.length > 0) {
      throw new Error(
        "Missing or unusable production observability env vars: " +
          `${sentryProblems.join(", ")}. Sentry would be a silent no-op on this ` +
          "deploy — see DEPLOY.md → Error monitoring.",
      );
    }
  }
}
