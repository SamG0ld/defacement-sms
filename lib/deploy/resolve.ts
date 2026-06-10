// Pure decision logic for the field-deployment endpoints — no DB, no I/O — so
// the gnarly parts (idempotency, exclusive-lock rejection reasons, deploy
// conflict classification) are unit-testable in isolation. The route handlers
// do the DB reads/writes and hand the results here for classification.
//
// See lib/deploy/contract.ts for the wire shapes these produce.

import type {
  ClaimRejection,
  ClaimResponse,
  DeployEventInput,
  DeployResult,
} from "@/lib/deploy/contract";

// ── Claims ────────────────────────────────────────────────────────────────────

// Current lock-relevant state of a sign, as read back after the conditional
// claim UPDATE. `undefined` for an id means no such sign.
export type SignClaimState = {
  status: string; // SignStatus
  claimedByCrewId: number | null;
};

// Build the claim response from: the requested ids, the crew that asked, the ids
// the crew now holds (`grantedIds` — both freshly locked by the conditional
// UPDATE and any idempotent re-claims it already held), and the post-update state
// of every requested sign. The UPDATE only matches `sorted` + currently-unclaimed
// rows; this function explains the rest. `grantedIds` may include already-held
// signs (the caller derives it from "claimedByCrewId === this crew"), so a
// re-claim flows through the fast path here — that's intended idempotency, not a
// contract violation.
export function buildClaimResponse(
  requestedIds: number[],
  requestingCrewId: number,
  grantedIds: Iterable<number>,
  stateById: Map<number, SignClaimState>,
): ClaimResponse {
  const granted_ = grantedIds instanceof Set ? grantedIds : new Set(grantedIds);
  const granted: number[] = [];
  const rejected: ClaimRejection[] = [];
  // De-dupe requested ids while preserving first-seen order.
  const seen = new Set<number>();

  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    if (granted_.has(id)) {
      granted.push(id);
      continue;
    }

    const state = stateById.get(id);
    if (!state) {
      rejected.push({ signId: id, reason: "not_found", byCrewId: null });
      continue;
    }
    // Idempotent re-claim: this crew already holds the lock. The conditional
    // UPDATE skipped it (claimedByCrewId was not null), but it IS ours.
    if (state.claimedByCrewId === requestingCrewId) {
      granted.push(id);
      continue;
    }
    // Held by a different crew — the exclusive-lock loss.
    if (state.claimedByCrewId !== null) {
      rejected.push({
        signId: id,
        reason: "already_claimed",
        byCrewId: state.claimedByCrewId,
      });
      continue;
    }
    // Unclaimed but not granted → it isn't in the claimable phase.
    if (state.status !== "sorted") {
      rejected.push({ signId: id, reason: "not_sorted", byCrewId: null });
      continue;
    }
    // Unclaimed + sorted but the UPDATE didn't take it: a transient race (another
    // tx grabbed and released, or it flipped between UPDATE and read). Treat as
    // claimed-by-someone so the client retries/picks another rather than assuming
    // success.
    rejected.push({ signId: id, reason: "already_claimed", byCrewId: null });
  }

  return { granted, rejected };
}

// ── Deploys ─────────────────────────────────────────────────────────────────

export type DeployClassification = {
  // Events that should set the sign to `deployed` (first writer wins).
  toApply: DeployEventInput[];
  // Events to record in the deploy log as conflicts (sign already deployed) —
  // logged for after-action review, but they don't change the sign.
  toLogConflict: DeployEventInput[];
  // clientIds in `toApply`, as a Set, so callers can label event rows without an
  // O(n) `Array.includes` scan (and without depending on object identity).
  applyClientIds: Set<string>;
  // Per-event wire results (includes duplicates, which are otherwise dropped).
  results: DeployResult[];
};

// Classify a batch of deploy events given which clientIds the server has already
// processed (`existingClientIds` → duplicate/no-op) and which signs are already
// deployed (`deployedSignIds`). A sign deployed earlier *within this same batch*
// also makes later events for it conflicts, so we track that as we go. Within a
// batch the first event (in array order) for a not-yet-deployed sign wins.
export function classifyDeploys(
  events: DeployEventInput[],
  existingClientIds: Set<string>,
  deployedSignIds: Set<number>,
): DeployClassification {
  const toApply: DeployEventInput[] = [];
  const toLogConflict: DeployEventInput[] = [];
  const results: DeployResult[] = [];
  const deployedNow = new Set<number>(deployedSignIds);
  const seenClientIds = new Set<string>();

  for (const ev of events) {
    // Idempotent replay: already processed, or repeated within this batch.
    if (existingClientIds.has(ev.clientId) || seenClientIds.has(ev.clientId)) {
      results.push({ clientId: ev.clientId, signId: ev.signId, status: "duplicate" });
      continue;
    }
    seenClientIds.add(ev.clientId);

    if (deployedNow.has(ev.signId)) {
      toLogConflict.push(ev);
      results.push({ clientId: ev.clientId, signId: ev.signId, status: "conflict" });
      continue;
    }

    deployedNow.add(ev.signId);
    toApply.push(ev);
    results.push({ clientId: ev.clientId, signId: ev.signId, status: "applied" });
  }

  const applyClientIds = new Set(toApply.map((e) => e.clientId));
  return { toApply, toLogConflict, applyClientIds, results };
}
