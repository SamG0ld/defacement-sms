import { describe, it, expect } from "vitest";

import {
  presenceOnAnimationEnd,
  presenceOnPresentChange,
  type PresenceState,
} from "@/app/_components/usePresence";

// The usePresence hook is a thin wrapper around these two pure transitions; the
// DOM/animation wiring isn't testable in the pure-Node unit env, but the state
// machine that decides mount/exit/unmount is — and that's where the bugs live.

const OPEN: PresenceState = { rendered: true, exiting: false };
const EXITING: PresenceState = { rendered: true, exiting: true };
const CLOSED: PresenceState = { rendered: false, exiting: false };

describe("presenceOnPresentChange", () => {
  it("mounts when becoming present from closed", () => {
    expect(presenceOnPresentChange(CLOSED, true)).toEqual(OPEN);
  });

  it("starts the exit (stays mounted) when going absent while shown", () => {
    expect(presenceOnPresentChange(OPEN, false)).toEqual(EXITING);
  });

  it("cancels an in-flight exit when it becomes present again (re-entrancy)", () => {
    expect(presenceOnPresentChange(EXITING, true)).toEqual(OPEN);
  });

  it("is a no-op (same reference) when already open and still present", () => {
    expect(presenceOnPresentChange(OPEN, true)).toBe(OPEN);
  });

  it("is a no-op (same reference) when already closed and still absent", () => {
    expect(presenceOnPresentChange(CLOSED, false)).toBe(CLOSED);
  });

  it("does not re-trigger an exit while already exiting", () => {
    expect(presenceOnPresentChange(EXITING, false)).toBe(EXITING);
  });
});

describe("presenceOnAnimationEnd", () => {
  it("unmounts when the exit animation finishes", () => {
    expect(presenceOnAnimationEnd(EXITING)).toEqual(CLOSED);
  });

  it("ignores animationend from the entrance animation (not exiting)", () => {
    expect(presenceOnAnimationEnd(OPEN)).toBe(OPEN);
  });

  it("ignores animationend when already closed", () => {
    expect(presenceOnAnimationEnd(CLOSED)).toBe(CLOSED);
  });
});
