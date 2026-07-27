// Structured error logger + Sentry funnel. Emits one JSON line per call to stderr,
// which the Vercel runtime log viewer captures and makes filterable (search by
// `scope`), AND forwards the error to Sentry for durable storage + alerting (a
// complete no-op without SENTRY_DSN). Works in every runtime the app uses (node,
// edge, serverless). Thrown pg/Prisma errors are normalized so their `code`
// (e.g. ECONNREFUSED, 57P01) survives into the log for triage.
import * as Sentry from "@sentry/nextjs";

type LogMeta = Record<string, unknown>;

function normalizeError(err: unknown): {
  name?: string;
  message: string;
  code?: string | number;
} {
  if (err instanceof Error) {
    const code = (err as { code?: string | number }).code;
    return {
      name: err.name,
      message: err.message,
      ...(code !== undefined ? { code } : {}),
    };
  }
  return { message: String(err) };
}

// Log an error as one JSON line. `scope` is a dotted tag for filtering
// (e.g. "auth.jwt.db-unavailable"); `meta` adds context. The fixed fields
// (level/scope/err) always win over a colliding meta key, and serialization is
// guarded so logging can never itself throw.
export function logError(scope: string, err: unknown, meta?: LogMeta): void {
  try {
    console.error(
      JSON.stringify({
        ...meta,
        level: "error",
        scope,
        err: normalizeError(err),
      }),
    );
  } catch {
    console.error(`[${scope}] log serialization failed`);
  }
  // Forward to Sentry for durable storage + alerting (no-op without SENTRY_DSN).
  // `scope` becomes a tag so events filter the same way as the console line.
  // Guarded so observability can never itself break the request path.
  try {
    Sentry.captureException(err, { tags: { scope }, extra: meta });
  } catch {
    /* never throw from the logger */
  }
}

// Warn-level structured line for non-error operational signals (e.g. spend
// climbing toward a cap). Same one-JSON-line-to-stderr shape as logError so it
// stays filterable by `scope`, but level "warn" keeps it out of error alerting.
export function logWarn(scope: string, message: string, meta?: LogMeta): void {
  try {
    console.warn(JSON.stringify({ ...meta, level: "warn", scope, message }));
  } catch {
    console.warn(`[${scope}] log serialization failed`);
  }
}
