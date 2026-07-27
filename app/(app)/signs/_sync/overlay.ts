// Pure overlay reconciliation for the /signs status queue — no React, no IDB — so
// the subtle queued→synced / failed→discarded transitions are unit-testable in
// isolation (the provider just holds this in state and re-runs it after each
// outbox read).

import type { StatusOutboxEntry, StatusOverlay } from "./types";

// How long a "synced" badge may keep overriding the server-rendered status.
//
// The stickiness exists to stop the badge flickering back to the stale RSC value
// in the window between a successful drain and the router.refresh that reflects
// it — that window is one request, well under a second. Left unbounded (the
// overlay lives in provider state, which router.refresh does NOT unmount) it also
// pins the value for the life of the mounted provider: if ANOTHER crew or a lead
// later moves the same sign, this device keeps showing its own old status until a
// full reload. Three sync intervals is far past the refresh it protects and caps
// how long that masking can last. (#203)
export const SYNCED_TTL_MS = 60_000;

// Rebuild the overlay from the live outbox + the previous overlay:
//   - Signs still in the outbox show queued (or failed for a dead-letter). A sign
//     can legitimately have MULTIPLE entries (e.g. discard a failed one, then
//     re-queue) — entries are sorted by createdAt asc, so the LAST write wins.
//   - A sign that LEFT the outbox since last time either:
//       • synced (a non-failed entry drained → deleteEntry) → keep showing the
//         status, marked "synced" (sticky; equals server truth after router
//         .refresh, so the badge never flickers back to the stale RSC value), or
//       • was discarded (a previously-FAILED entry the user cleared) → drop it,
//         reverting that row to server truth.
//   Note prev[signId].indicator can already be "synced" from an earlier cycle;
//   the guard must stay `!== "failed"` (not `=== "queued"`) so a synced badge
//   stays sticky across subsequent reconciles — but only until SYNCED_TTL_MS has
//   passed, after which it's dropped and the row falls back to server truth. (#203)
//
// `now` is injectable so the TTL is testable without faking timers.
export function reconcile(
  prev: StatusOverlay,
  entries: StatusOutboxEntry[],
  now: number = Date.now(),
): StatusOverlay {
  const next: StatusOverlay = {};
  const inOutbox = new Set<number>();
  for (const e of entries) {
    inOutbox.add(e.signId);
    next[e.signId] = {
      status: e.status,
      indicator: e.queueStatus === "failed" ? "failed" : "queued",
    };
  }
  for (const key of Object.keys(prev)) {
    const signId = Number(key);
    if (inOutbox.has(signId)) continue;
    const entry = prev[signId];
    if (entry.indicator === "failed") continue;
    // Stamp the moment it first became synced, then let it expire. Dropping it
    // is the whole point: the row reverts to whatever the server now says, which
    // may be another crew's more recent change.
    const syncedAt = entry.syncedAt ?? now;
    if (now - syncedAt >= SYNCED_TTL_MS) continue;
    next[signId] = { status: entry.status, indicator: "synced", syncedAt };
  }
  return next;
}
