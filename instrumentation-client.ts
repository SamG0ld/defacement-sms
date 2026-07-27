// Sentry init for the BROWSER. Next.js auto-loads `instrumentation-client.ts` on
// the client, so no `withSentryConfig` is needed just to capture errors.
//
// Env-gated on NEXT_PUBLIC_SENTRY_DSN — unset = a complete no-op, so dev / CI /
// local behave exactly as before. Errors only: no performance tracing, no session
// replay, and `sendDefaultPii: false` (no IPs / cookies / PII attached). This
// captures unhandled exceptions + promise rejections that happen in the user's
// browser, plus whatever the error boundaries forward via Sentry.captureException.
//
// The DSN's ingest origin is allowed in `connect-src` by lib/csp.ts (derived from
// the DSN, gated on the same env) so the browser can POST events under the CSP.
import * as Sentry from "@sentry/nextjs";

import { sanitizeDsn } from "./lib/sentry-dsn";
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from "./lib/sentry-privacy";

// Sanitized, not raw. Prod's inlined NEXT_PUBLIC_SENTRY_DSN began with a U+FEFF
// BOM, which is truthy — so this SDK initialised `enabled: true` while
// @sentry/core rejected the DSN, and every browser event was dropped in silence.
// The literal `process.env.NEXT_PUBLIC_SENTRY_DSN` stays here so Next still
// inlines it into the client bundle at build time.
const dsn = sanitizeDsn(
  process.env.NEXT_PUBLIC_SENTRY_DSN,
  "NEXT_PUBLIC_SENTRY_DSN",
);

Sentry.init({
  dsn: dsn ?? undefined,
  enabled: Boolean(dsn),
  tracesSampleRate: 0,
  sendDefaultPii: false,
  dataCollection: SENTRY_DATA_COLLECTION,
  beforeSend: scrubSentryEvent,
  // Inlined at build via next.config.ts `env` so browser events match the server/
  // edge tagging (prod vs preview, and the deploy's commit). Empty → untagged.
  environment: process.env.SENTRY_ENVIRONMENT || undefined,
  release: process.env.SENTRY_RELEASE || undefined,
});
