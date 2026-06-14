import { logError } from "@/lib/log";

// Tells a TRANSIENT connection failure (safe to retry) apart from an
// authoritative result (a real query/constraint error, or a legit "no such row").
// A cold Neon compute (scale-to-zero) refuses or times out the first connection
// after idle; the node-postgres pool also throws a synthetic "timeout exceeded
// when trying to connect" once connectionTimeoutMillis elapses. Those are infra
// blips — NOT a deactivation — and must not be treated as one.

// Prisma surfaces an unreachable / cold DB as PrismaClientInitializationError,
// which carries the P-code on `.errorCode` (and, depending on path, `.code`) —
// NOT the pg errno. P1001 unreachable, P1008 timed out, P1017 server closed the
// connection. These are THE common Neon cold-start signatures via the Prisma layer.
const PRISMA_TRANSIENT_CODES = new Set(["P1001", "P1008", "P1017"]);

// Raw node-postgres / libpq failures: 08-class SQLSTATE + socket errnos.
const TRANSIENT_PG_CLASS = "08"; // connection_exception family
const TRANSIENT_CODES = new Set([
  "57P01", // admin_shutdown
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN", // transient DNS resolution failure
]);

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errorCode?: unknown; message?: unknown };

  // Prefer STRUCTURED codes — tight, no false positives. A transient signature can
  // arrive on `.code` (pg errno / SQLSTATE) or `.errorCode` (Prisma init error), so
  // check both fields against both code sets.
  for (const c of [e.code, e.errorCode]) {
    if (typeof c !== "string") continue;
    if (PRISMA_TRANSIENT_CODES.has(c)) return true;
    if (TRANSIENT_CODES.has(c)) return true;
    if (c.startsWith(TRANSIENT_PG_CLASS)) return true;
  }

  // Message fallback is consulted ONLY when there is no structured code to trust
  // (the pg pool's connect-timeout has no code; some wrapped errors lose theirs).
  // Patterns are specific to connection failures so an authoritative query/
  // constraint error is never misclassified as transient (and thus never soft-
  // passed by the auth refresh path).
  const hasStructuredCode =
    typeof e.code === "string" || typeof e.errorCode === "string";
  if (!hasStructuredCode && typeof e.message === "string") {
    return (
      /timeout exceeded when trying to connect/i.test(e.message) ||
      /Can't reach database server/i.test(e.message) ||
      /Server has closed the connection/i.test(e.message) ||
      /Connection terminated/i.test(e.message)
    );
  }
  return false;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type RetryOptions = {
  /** Extra attempts after the first. Default 1 (so 2 attempts total). */
  retries?: number;
  /** Base backoff; the Nth retry waits backoffMs * N. Default 300ms. */
  backoffMs?: number;
  /** Log tag for the retry line. */
  scope?: string;
};

// Run a DB operation, retrying ONLY transient connection failures. One retry by
// default: the first attempt wakes a cold Neon compute, the retry lands on the
// now-warm endpoint. A non-transient error rethrows immediately so real bugs are
// never masked or delayed.
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  { retries = 1, backoffMs = 300, scope = "db" }: RetryOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientDbError(err)) throw err;
      attempt += 1;
      logError(`${scope}.retry`, err, { attempt, retries });
      await sleep(backoffMs * attempt);
    }
  }
}
