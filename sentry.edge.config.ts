// Sentry init for the Edge runtime (proxy.ts middleware runs here). Loaded once at
// startup by instrumentation.ts (register) when NEXT_RUNTIME === "edge". Same
// env-gating as the server config — no usable DSN, no-op.
//
// #272: this used to read `process.env.SENTRY_DSN` directly, which on prod was
// unusable in this runtime — so `enabled` was false and the whole edge SDK was a
// no-op, silently disabling onRequestError for middleware too. resolveSentryDsn()
// falls back to the build-inlined NEXT_PUBLIC_SENTRY_DSN, which the edge bundle
// always carries, and strips the BOM that made the stored value unparseable.
import * as Sentry from "@sentry/nextjs";

import { resolveSentryDsn } from "./lib/sentry-dsn";
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from "./lib/sentry-privacy";

const dsn = resolveSentryDsn();

Sentry.init({
  dsn: dsn ?? undefined,
  // Gate on the RESOLVED dsn, never on the raw env var: a truthy-but-invalid
  // value would otherwise enable an SDK that cannot send anything.
  enabled: Boolean(dsn),
  tracesSampleRate: 0,
  // See lib/sentry-privacy.ts — sendDefaultPii alone leaves cookies/headers on
  // the event. proxy.ts is the auth gate, so this runtime sees every session
  // cookie in the app.
  sendDefaultPii: false,
  dataCollection: SENTRY_DATA_COLLECTION,
  beforeSend: scrubSentryEvent,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
});
