import * as Sentry from "@sentry/nextjs";

// Next.js calls register() once at server startup. Two jobs:
//  1) Initialize Sentry for the active runtime (node or edge). Both inits are
//     env-gated (no SENTRY_DSN → no-op), so this stays inert until a DSN is set.
//  2) Fail fast on a misconfigured production deploy (see lib/env.ts). This runs at
//     runtime, not during `next build`, so a local build without prod secrets still
//     succeeds. Sentry is initialized first so a fail-fast startup throw is captured.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  const { assertProdEnv } = await import("./lib/env");
  assertProdEnv();
}

// Next's onRequestError hook — routes errors thrown in Server Components, route
// handlers, Server Actions, and middleware to Sentry (no-op without a DSN). This is
// what captures the uncaught 500s; caught-and-logged errors reach Sentry via
// logError() (lib/log.ts).
export const onRequestError = Sentry.captureRequestError;
