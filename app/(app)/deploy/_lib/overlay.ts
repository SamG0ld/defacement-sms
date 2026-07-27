// Pure optimistic-overlay projection for the deploy tool — no React, no IDB — so
// the "what does the floor see before the server has heard about it" rules are
// unit-testable in isolation (the store just holds the result in state).
//
// The overlay is REPLAYABLE by design. The store used to derive optimistic state
// inline inside claim/release/deploy, which meant it could only ever be applied
// once, at the moment of the action. bootstrapNow() then replaced `signs`
// wholesale with server truth and every still-queued mutation vanished from the
// UI — a volunteer who reloaded mid-shift watched their claimed/deployed signs
// revert while the durable outbox still held them, which invites double-claiming
// the same sign. Folding the outbox back over server truth on every bootstrap
// fixes that, and makes this module the single definition of optimistic truth.
// (#184 — mirrors the /signs queue's reconcile() in signs/_sync/overlay.ts.)

import type { DeploySignView } from "@/lib/deploy/contract";

import type {
  ClaimPayload,
  DeployPayload,
  OutboxEntry,
  ReleasePayload,
} from "./types";

type SignMap = Record<number, DeploySignView>;

// Fold every still-pending outbox entry over a server snapshot, oldest first, so
// the result is what the user should be looking at. Guards match the server's own
// rules so the overlay never claims something the server would reject:
//   - claim   — only an unclaimed sign in the `sorted` phase (claiming is
//               post-sort only, and the lock is exclusive).
//   - release — only a sign this crew actually holds.
//   - deploy  — terminal; also consumes the claim lock.
//   - photo   — no sign-visible effect (the URL comes back from the upload).
// Dead-lettered (failed) entries are deliberately NOT applied: they will never
// reach the server, so showing their effect would be a lie the UI never corrects.
export function applyOutboxOverlay(
  signs: SignMap,
  entries: OutboxEntry[],
  currentUserId: string,
): SignMap {
  const pending = entries
    .filter((e) => e.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (pending.length === 0) return signs;

  const next: SignMap = { ...signs };
  for (const entry of pending) {
    if (entry.kind === "claim") {
      const p = entry.payload as ClaimPayload;
      for (const id of p.signIds) {
        const s = next[id];
        if (s && s.claimedByCrewId === null && s.status === "sorted") {
          next[id] = {
            ...s,
            claimedByCrewId: p.crewId,
            claimedByUserId: currentUserId,
          };
        }
      }
    } else if (entry.kind === "release") {
      const p = entry.payload as ReleasePayload;
      for (const id of p.signIds) {
        const s = next[id];
        if (s && s.claimedByCrewId === p.crewId) {
          next[id] = { ...s, claimedByCrewId: null, claimedByUserId: null };
        }
      }
    } else if (entry.kind === "deploy") {
      const p = entry.payload as DeployPayload;
      const s = next[p.signId];
      if (s) {
        next[p.signId] = {
          ...s,
          status: "deployed",
          // The instant the volunteer actually acted (captured at enqueue), not
          // "now" — replaying must not drift the timestamp on every bootstrap.
          deployedAt: p.deployedAt,
          claimedByCrewId: null,
          claimedByUserId: null,
        };
      }
    }
    // "photo": no sign-visible effect until the upload returns a URL.
  }
  return next;
}
