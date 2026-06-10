// Next.js calls register() once at server startup. We use it to fail fast on a
// misconfigured production deploy (see lib/env.ts). This runs at runtime, not
// during `next build`, so a local build without prod secrets still succeeds.
export async function register() {
  const { assertProdEnv } = await import("./lib/env");
  assertProdEnv();
}
