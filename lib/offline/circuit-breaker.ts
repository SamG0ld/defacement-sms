// A small circuit breaker shared by both offline sync engines. Without it, a
// degraded server (DB overloaded, cold-start cascade) gets hammered at the full
// 20s sync cadence by every device forever — the devices accelerate the outage
// instead of backing off. After a run of transient failures the breaker opens,
// backs off exponentially, and lets through a single probe per window until the
// server recovers. 401/403 are NOT failures here (the server is healthy — the
// session/account is the problem); only NetworkError / 5xx / 429 are. (#81)

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
  // True if a sync may proceed now. In the open state this returns true at most
  // once per backoff window (the half-open probe); the caller MUST report the
  // outcome via onSuccess/onFailure.
  canRequest(): boolean;
  onSuccess(): void;
  onFailure(): void;
  // Grant ONE immediate request, without forgiving the accumulated failures.
  // For the fresh-mount probe ONLY (see #206): the breaker is module-scoped so it
  // survives remounts, which is right for the common case but means a user who
  // navigates away and back to force a sync after a hiccup hits a window they
  // can't see or clear.
  //
  // Deliberately NOT a full reset. Zeroing `failures` would return the breaker to
  // "closed", where canRequest() is unconditionally true — buying `threshold`
  // full-cadence attempts per mount and restarting the exponential ramp from the
  // base delay. With a mount available every 30s that sustains near-full cadence
  // against a server the breaker had already backed off to one request per
  // maxDelayMs, on the exact small pg pool the breaker exists to protect during
  // con week. Keeping `failures` means this probe's outcome resumes the ramp
  // where it left off. Never call it on a server signal.
  probeOnce(): void;
  readonly state: CircuitState;
}

export function createCircuitBreaker(
  opts: {
    threshold?: number; // consecutive failures before opening
    baseDelayMs?: number; // first backoff once open
    maxDelayMs?: number; // backoff ceiling
    now?: () => number; // injectable clock (tests)
  } = {},
): CircuitBreaker {
  const threshold = opts.threshold ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 20_000;
  const maxDelayMs = opts.maxDelayMs ?? 300_000;
  const clock = opts.now ?? (() => Date.now());

  let failures = 0;
  let nextAttempt = 0; // epoch ms; while clock() < nextAttempt the breaker is open
  let probing = false; // a half-open probe is out, awaiting its outcome

  // Exponential backoff once tripped: failures===threshold → base, then ×2 per
  // extra failure, capped (e.g. 20s → 40s → 80s … → maxDelayMs).
  function backoff(): number {
    return Math.min(baseDelayMs * 2 ** (failures - threshold), maxDelayMs);
  }

  return {
    get state(): CircuitState {
      if (failures < threshold) return "closed";
      if (probing) return "half-open";
      return clock() >= nextAttempt ? "half-open" : "open";
    },
    canRequest(): boolean {
      if (failures < threshold) return true; // closed — always allowed
      if (probing) return false; // a probe is already in flight
      if (clock() < nextAttempt) return false; // open — still backing off
      probing = true; // half-open — hand out exactly one probe
      return true;
    },
    onSuccess(): void {
      failures = 0;
      nextAttempt = 0;
      probing = false;
    },
    onFailure(): void {
      failures += 1;
      probing = false;
      if (failures >= threshold) nextAttempt = clock() + backoff();
    },
    probeOnce(): void {
      // Re-open the gate but keep `failures`: canRequest() then hands out exactly
      // one half-open probe, and onFailure() resumes the backoff ramp from where
      // it was rather than restarting it.
      nextAttempt = 0;
      probing = false;
    },
  };
}
