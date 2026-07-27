import { describe, it, expect } from "vitest";

import {
  presenceShouldUnmount,
  presenceState,
} from "@/app/_components/usePresence";

// usePresence is a thin wrapper around these two pure derivations. The DOM /
// animation wiring isn't testable in the pure-Node unit env — and neither is the
// #149 failure itself, which lived in React's render scheduling rather than in
// this state machine (tests/manual/bulkbar-clear-check.mjs is that guard). What
// IS testable here, and what #149 turned on, is the shape: `exiting` must be a
// pure function of (mounted, present) so nothing can revert it.

describe("presenceState", () => {
  it("is closed when neither mounted nor present", () => {
    expect(presenceState(false, false)).toEqual({
      rendered: false,
      exiting: false,
    });
  });

  it("renders on the first frame it becomes present, before `mounted` catches up", () => {
    // The committed effect sets `mounted` a frame later; `rendered` must not wait
    // on it, or the node would flash in one frame late.
    expect(presenceState(false, true)).toEqual({
      rendered: true,
      exiting: false,
    });
  });

  it("is open while mounted and present", () => {
    expect(presenceState(true, true)).toEqual({
      rendered: true,
      exiting: false,
    });
  });

  it("stays rendered and marks exiting when present goes false", () => {
    expect(presenceState(true, false)).toEqual({
      rendered: true,
      exiting: true,
    });
  });

  it("derives exiting from the live present — the same inputs always give the same answer (#149)", () => {
    // The regression: `exiting` used to be stored, and a discarded render-phase
    // update reverted it true -> false mid-exit, cancelling the dismissal. A
    // derived flag has no state to lose, so recomputing can never disagree.
    expect(presenceState(true, false).exiting).toBe(true);
    expect(presenceState(true, false).exiting).toBe(
      presenceState(true, false).exiting,
    );
  });

  it("cancels the exit as soon as present returns (re-entrancy)", () => {
    expect(presenceState(true, true).exiting).toBe(false);
  });
});

describe("presenceShouldUnmount", () => {
  it("unmounts when the exit animation finishes", () => {
    expect(presenceShouldUnmount(true, false)).toBe(true);
  });

  it("ignores animationend from the entrance animation (still present)", () => {
    // The entrance `animationend` bubbles to the same handler as the exit's.
    expect(presenceShouldUnmount(true, true)).toBe(false);
  });

  it("ignores animationend when already unmounted", () => {
    expect(presenceShouldUnmount(false, false)).toBe(false);
  });

  it("never unmounts a node that is present but not yet marked mounted", () => {
    expect(presenceShouldUnmount(false, true)).toBe(false);
  });
});
