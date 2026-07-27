"use client";

// Keeps a node mounted through its exit animation. `present` is the live desired
// visibility; the node stays rendered while visible AND while animating out,
// unmounting only when the exit animation's `animationend` fires (or a fallback
// timer, whichever lands first). Pair with a CSS class that runs an entrance
// animation on mount and an exit animation when `data-exiting` is set; the
// reduced-motion guard (0.01ms, iteration 1) still fires `animationend`, so the
// unmount happens even with motion disabled.
//
// There is exactly ONE piece of state here — `mounted` — and `exiting` is DERIVED
// from it plus the live `present`. That shape is load-bearing, not stylistic
// (#149). The previous version STORED `exiting` and set it from a render-phase
// `setState`; React discards a render-phase update whenever a follow-up re-render
// restarts from base state, so `exiting` silently reverted true -> false about 9ms
// after commit. The bulk bar cancelled its own exit and sat there fully armed
// showing a stale count. #141's timeout fallback keyed off that same `exiting`
// flag, so its cleanup cleared the timer at the exact instant the flag reverted —
// which is why that fix shipped ineffective. A derived flag cannot be reverted: it
// is recomputed from `present` on every render.
//
// The rule that falls out of that, for anything added here later: never let a
// render-phase update be the only thing keeping a node on screen. Assume it can
// vanish, and make its loss cost an animation rather than a dismissal.
//
// The transitions are pure + exported so the state machine is unit-testable in the
// pure-Node test env (no DOM/renderHook). Note that a Node unit test structurally
// CANNOT catch the #149 failure — it lives in React's render scheduling, not in
// this state machine. `tests/manual/bulkbar-clear-check.mjs` is that guard.

import { useEffect, useState } from "react";

export type PresenceState = { rendered: boolean; exiting: boolean };

// Fallback timeout for the exit unmount when `animationend` never fires. Sized
// well above the CSS exit animation (`dfx-slidedown` runs for --motion-base =
// 200ms) so the real animation reliably wins the race in the normal case — the
// extra headroom matters on the low-end phones this app targets on the floor,
// where a slow-but-still-firing `animationend` shouldn't get pre-empted into an
// abrupt snap. The fallback is purely defensive, so a slightly slower worst-case
// dismissal is a fine trade for a smoother normal-case slide-out.
const EXIT_FALLBACK_MS = 400;

// What the caller renders, derived from the sticky `mounted` flag and the live
// `present`. `rendered` ors in `present` so a node is in the tree on the very
// first frame it becomes present, without needing a render-phase state update to
// get there.
export function presenceState(
  mounted: boolean,
  present: boolean,
): PresenceState {
  return { rendered: mounted || present, exiting: mounted && !present };
}

// Whether an unmount is due right now. Guards both the `animationend` handler and
// the fallback timer, so the ENTRANCE animation's `animationend` — which bubbles
// to the same handler — is ignored, and a node re-shown mid-exit is never torn
// down under the user.
export function presenceShouldUnmount(
  mounted: boolean,
  present: boolean,
): boolean {
  return mounted && !present;
}

export function usePresence(present: boolean) {
  const [mounted, setMounted] = useState(present);

  // React's endorsed "derive state from a changing value" render-phase update —
  // but here it is only an OPTIMIZATION, never load-bearing. If the scheduler
  // discards it (the #149 mechanism) the node simply unmounts on the spot instead
  // of playing its slide-out, because `rendered` ors in `present` and `exiting`
  // needs `mounted`. Losing an animation is a cosmetic degrade; the old design
  // lost the dismissal itself. Nothing below can leave a node stranded on screen:
  // staying rendered while absent requires `mounted`, and `mounted` is only ever
  // cleared by committed updates (animationend / the fallback timer).
  if (present && !mounted) setMounted(true);

  const { rendered, exiting } = presenceState(mounted, present);

  const onAnimationEnd = () => {
    if (presenceShouldUnmount(mounted, present)) setMounted(false);
  };

  // Fallback unmount for when `animationend` doesn't arrive at all (a hidden
  // ancestor, a cancelled animation, a browser that drops the event). Keyed on
  // (mounted, present) — never on the exit flag itself, which is the mistake that
  // made the #141 version unable to fire.
  useEffect(() => {
    if (!presenceShouldUnmount(mounted, present)) return;
    const timer = setTimeout(() => setMounted(false), EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [mounted, present]);

  return { rendered, exiting, onAnimationEnd };
}
