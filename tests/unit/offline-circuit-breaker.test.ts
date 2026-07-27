import { describe, it, expect } from "vitest";

import { createCircuitBreaker } from "@/lib/offline/circuit-breaker";

// A controllable clock so backoff windows are deterministic.
function withClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

describe("createCircuitBreaker", () => {
  // A fresh mount gets one immediate attempt regardless of the backoff window:
  // the breaker is module-scoped (survives remounts by design), so a volunteer who
  // navigates away and back to force a sync would otherwise hit a window they
  // can't see or clear, and the tool reads as hung. (#206)
  describe("probeOnce() — the fresh-mount probe", () => {
    it("hands out exactly ONE request from an open breaker", () => {
      const clock = withClock();
      const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
      cb.onFailure();
      cb.onFailure();
      cb.onFailure();
      expect(cb.canRequest()).toBe(false);

      cb.probeOnce();
      expect(cb.canRequest()).toBe(true);
      // …and only one: the breaker is NOT forgiven back to closed.
      expect(cb.canRequest()).toBe(false);
    });

    it("does NOT clear accumulated failures — the backoff ramp resumes, not restarts", () => {
      const clock = withClock();
      const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
      cb.onFailure();
      cb.onFailure();
      cb.onFailure(); // 3 failures → backoff 1000
      cb.probeOnce();
      expect(cb.canRequest()).toBe(true);
      cb.onFailure(); // 4th failure → backoff 2000, NOT back to 1000

      clock.advance(1000);
      expect(cb.canRequest()).toBe(false); // still backing off — ramp continued
      clock.advance(1000);
      expect(cb.canRequest()).toBe(true);
    });

    it("clears an in-flight probe so the breaker can't stay wedged", () => {
      const clock = withClock();
      const cb = createCircuitBreaker({ threshold: 1, baseDelayMs: 1000, now: clock.now });
      cb.onFailure();
      clock.advance(1000);
      expect(cb.canRequest()).toBe(true); // probe handed out…
      expect(cb.canRequest()).toBe(false); // …and its outcome never reported

      cb.probeOnce();
      expect(cb.canRequest()).toBe(true);
    });

    it("is a safe no-op on an already-closed breaker", () => {
      const cb = createCircuitBreaker({ threshold: 3 });
      cb.probeOnce();
      expect(cb.state).toBe("closed");
      expect(cb.canRequest()).toBe(true);
    });
  });

  it("stays closed and allows requests below the failure threshold", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    expect(cb.state).toBe("closed");
    expect(cb.canRequest()).toBe(true);
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("closed");
    expect(cb.canRequest()).toBe(true);
  });

  it("opens after `threshold` consecutive failures and blocks until backoff elapses", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("open");
    expect(cb.canRequest()).toBe(false);
    clock.set(999);
    expect(cb.canRequest()).toBe(false);
  });

  it("allows exactly ONE probe once the backoff window elapses (half-open)", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    clock.set(1000);
    expect(cb.state).toBe("half-open");
    expect(cb.canRequest()).toBe(true); // the probe
    expect(cb.canRequest()).toBe(false); // no second probe until it resolves
  });

  it("resets to closed on a successful probe", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    clock.set(1000);
    cb.canRequest(); // probe
    cb.onSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.canRequest()).toBe(true);
  });

  it("re-opens with a longer backoff after a failed probe (exponential)", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure(); // open, backoff 1000 → nextAttempt 1000
    clock.set(1000);
    cb.canRequest(); // probe
    cb.onFailure(); // failed probe → backoff 2000 → nextAttempt 3000
    clock.set(2999);
    expect(cb.canRequest()).toBe(false);
    clock.set(3000);
    expect(cb.canRequest()).toBe(true);
  });

  it("caps the backoff at maxDelayMs", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({
      threshold: 1,
      baseDelayMs: 1000,
      maxDelayMs: 4000,
      now: clock.now,
    });
    // failures: 1→1000, 2→2000, 3→4000, 4→min(8000,4000)=4000
    cb.onFailure(); // nextAttempt 1000
    clock.set(1000);
    cb.canRequest();
    cb.onFailure(); // nextAttempt 1000+2000=3000
    clock.set(3000);
    cb.canRequest();
    cb.onFailure(); // nextAttempt 3000+4000=7000
    clock.set(7000);
    cb.canRequest();
    cb.onFailure(); // nextAttempt 7000+4000=11000 (capped, not 8000)
    clock.set(10999);
    expect(cb.canRequest()).toBe(false);
    clock.set(11000);
    expect(cb.canRequest()).toBe(true);
  });

  it("stays blocked if a probe is handed out but its outcome is never reported (caller contract)", () => {
    // Documents the caller's obligation: after canRequest() returns true in the
    // open state, the caller MUST call onSuccess/onFailure. If it doesn't, the
    // breaker correctly refuses further probes (better a stall than a hammer) —
    // which is exactly why every syncNow catch arm must resolve the breaker.
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    clock.set(1000);
    expect(cb.canRequest()).toBe(true); // probe issued
    clock.set(100_000); // even far in the future…
    expect(cb.canRequest()).toBe(false); // …no second probe until the first resolves
  });

  it("is half-open while a probe is in flight but canRequest refuses a second", () => {
    const clock = withClock();
    const cb = createCircuitBreaker({ threshold: 3, baseDelayMs: 1000, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    clock.set(1000);
    cb.canRequest(); // probe out
    expect(cb.state).toBe("half-open");
    expect(cb.canRequest()).toBe(false);
  });

  it("onSuccess() on an already-closed breaker is a safe no-op (called every clean tick)", () => {
    const cb = createCircuitBreaker({ threshold: 3 });
    expect(cb.state).toBe("closed");
    cb.onSuccess();
    cb.onSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.canRequest()).toBe(true);
  });
});
