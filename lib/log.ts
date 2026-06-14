// Minimal structured logger. Emits one JSON line per call to stderr, which the
// Vercel runtime log viewer captures and makes filterable (search by `scope`).
// Dependency-free — a single console.error works in every runtime the app uses
// (node, edge, serverless). Thrown pg/Prisma errors are normalized so their
// `code` (e.g. ECONNREFUSED, 57P01) survives into the log for triage.

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
}
