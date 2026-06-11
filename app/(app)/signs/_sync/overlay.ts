// Pure overlay reconciliation for the /signs status queue — no React, no IDB — so
// the subtle queued→synced / failed→discarded transitions are unit-testable in
// isolation (the provider just holds this in state and re-runs it after each
// outbox read).

import type { StatusOutboxEntry, StatusOverlay } from "./types";

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
//   stays sticky across subsequent reconciles until a reload clears the overlay.
export function reconcile(
  prev: StatusOverlay,
  entries: StatusOutboxEntry[],
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
    if (prev[signId].indicator !== "failed") {
      next[signId] = { status: prev[signId].status, indicator: "synced" };
    }
  }
  return next;
}
