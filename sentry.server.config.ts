// Sentry init for the Node server runtime. Loaded once at startup by
// instrumentation.ts (register) when NEXT_RUNTIME === "nodejs".
//
// Env-gated: with no SENTRY_DSN this is a COMPLETE no-op (enabled:false), so dev,
// CI, local builds, and any deploy without the DSN behave exactly as before. We
// load only the server + edge SDK — no browser SDK — so the app's nonce CSP
// (lib/csp.ts) needs no connect-src change.
import * as Sentry from "@sentry/nextjs";

import { resolveSentryDsn } from "./lib/sentry-dsn";
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from "./lib/sentry-privacy";

// Resolved + sanitized (see lib/sentry-dsn.ts): a DSN carrying a stray BOM is
// truthy but unparseable, which would init the SDK enabled-but-dead.
const dsn = resolveSentryDsn();

Sentry.init({
  dsn: dsn ?? undefined,
  enabled: Boolean(dsn),
  // Errors only for now — no performance tracing (keeps quota + overhead minimal;
  // raise deliberately later if we want spans).
  tracesSampleRate: 0,
  // Don't attach IPs / request bodies / cookies. sendDefaultPii alone does NOT
  // achieve that at this SDK version — see lib/sentry-privacy.ts for the measured
  // detail; without the dataCollection + beforeSend lines below, onRequestError
  // ships the session cookie.
  sendDefaultPii: false,
  dataCollection: SENTRY_DATA_COLLECTION,
  // Stop buffering incoming request BODIES at the source. @sentry/node-core's
  // httpServerIntegration defaults maxRequestBodySize to "medium" (10KB) and
  // contains no reference to sendDefaultPii or dataCollection, so every POST
  // payload — sign imports, login form fields — is captured onto
  // `event.request.data` regardless of the PII flag. Name-matched, so this
  // REPLACES the default httpIntegration rather than adding a second one; no
  // other option is passed, so everything else keeps its default.
  integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
  beforeSend: scrubSentryEvent,
  // Distinguish prod vs preview vs dev, and tie events to the deploy.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
});
