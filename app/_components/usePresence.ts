"use client";

// Keeps a node mounted through its exit animation. `present` is the live desired
// visibility; the node stays rendered while visible AND while animating out,
// unmounting only when the exit animation's `animationend` fires. Pair with a CSS
// class that runs an entrance animation on mount and an exit animation when
// `data-exiting` is set; the reduced-motion guard (0.01ms, iteration 1) still
// fires `animationend`, so the unmount happens even with motion disabled.
//
// The state machine is two pure, exported transitions so it can be unit-tested in
// the pure-Node test env (no DOM/renderHook); the hook is a thin wrapper.

import { useState } from "react";

export type PresenceState = { rendered: boolean; exiting: boolean };

// Reaction to a change in the desired `present` flag. Idempotent: returns the
// SAME state reference when nothing changes, so the hook doesn't re-render
// needlessly.
export function presenceOnPresentChange(
  state: PresenceState,
  present: boolean,
): PresenceState {
  if (present) {
    // Becoming/staying present cancels any in-flight exit.
    if (state.rendered && !state.exiting) return state;
    return { rendered: true, exiting: false };
  }
  // Going absent while shown → start the exit (keep it mounted, mark exiting).
  if (state.rendered && !state.exiting) return { rendered: true, exiting: true };
  // Already closed or already exiting — nothing to do.
  return state;
}

// Reaction to the exit animation finishing: unmount iff we were exiting.
export function presenceOnAnimationEnd(state: PresenceState): PresenceState {
  return state.exiting ? { rendered: false, exiting: false } : state;
}

export function usePresence(present: boolean) {
  const [state, setState] = useState<PresenceState>(() => ({
    rendered: present,
    exiting: false,
  }));
  const [prevPresent, setPrevPresent] = useState(present);

  // Adjust state during render when `present` flips — React's endorsed
  // "derive state from a changing prop" pattern (no effect, so no
  // cascading-render). React re-renders synchronously without committing the
  // intermediate output; the guard makes it run once per change, not loop.
  if (present !== prevPresent) {
    setPrevPresent(present);
    setState((s) => presenceOnPresentChange(s, present));
  }

  const onAnimationEnd = () => setState(presenceOnAnimationEnd);

  return { rendered: state.rendered, exiting: state.exiting, onAnimationEnd };
}
