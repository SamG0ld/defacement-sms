// Shared HTTP-status semantics for the offline sync engines (the /deploy floor
// tool and the /signs status queue). Both engines independently grew the SAME
// 401/403/429/5xx handling — and the same bug fixed in one copy and forgotten in
// the other is exactly the class of defect M17 Track A exists to kill. This is
// the single source of truth both engines import.

// How a non-2xx response should steer the drain:
//   auth-expired — 401: the session ended. The queued work CAN still succeed once
//                  the user signs back in, so keep it and prompt a re-auth.
//   forbidden    — 403: the actor isn't allowed (e.g. a deactivated account).
//                  Permanent — dead-letter it, but tell the user it was refused.
//   rate-limited — 429: transient backpressure. Retry.
//   transient    — 5xx (and anything else worth a retry). Stop the drain, retry.
//   permanent    — other 4xx (malformed/not-found): will never succeed on replay.
export type HttpCategory =
  | "auth-expired"
  | "forbidden"
  | "rate-limited"
  | "transient"
  | "permanent";

export function classifyHttpStatus(status: number): HttpCategory {
  if (status === 401) return "auth-expired";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 400 && status < 500) return "permanent";
  return "transient"; // 5xx and anything else — worth retrying
}

// A non-2xx that will never succeed on replay → move the entry to the
// dead-letter. 4xx EXCEPT 429 (retryable backpressure) and 401 (auth-expiry:
// succeeds after re-login). Note 403 IS permanent — a deactivated account stays
// deactivated, so the queue must dead-letter rather than retry forever (#79).
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429 && status !== 401;
}
