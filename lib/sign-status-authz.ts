// H2 (#17) + #20: authorization POLICY for sign status changes, shared by every
// entry point — the online single/bulk Server Actions AND the native offline-sync
// API — so a volunteer can't bypass the rule through whichever path lacks a guard.
//
// Model (leads/admins are unrestricted):
//  - Volunteers may only move a sign FORWARD. Backward moves (regressions) are
//    lead/admin only — that's what protects deploy attribution from being erased.
//  - Marking a sign `deployed` additionally requires the volunteer's crew to hold
//    the sign's claim — so a volunteer can't inflate the floor count with signs
//    they never claimed. Other forward "prep" transitions (e.g. → sorted) stay
//    open, since claiming a sign requires it to already be sorted (a blanket
//    claimed-only rule would block prep work).
//  - The external-item terminal statuses `handed_off` / `installed` rank ABOVE
//    `deployed`, so without an explicit rule a volunteer could "advance" any sign
//    into them via the generic status path. They're lead/admin-only here. The
//    legitimate volunteer route for external items is the dedicated lifecycle
//    actions (recordHandoff / confirmInstalled), a separate, self-guarded flow.
//  - Those same two statuses only make sense for an EXTERNALLY-installed item
//    (union_installed / ops_map). On any other class they're a dead end: the
//    stamps get written but the structured handoff fields stay null and
//    LifecyclePanel never renders, so there's no route back through the dedicated
//    UI. Enforced for EVERY role (ahead of the privileged bypass) — a lead
//    misclicking `installed` on an easel sign is the actual reported failure. (#232)
//
// Partially out of scope — these two paths do NOT run the full decision, for
// reasons that are about CLAIMS and RE-SUBMIT ORDERING only:
//  - `applyDeploys` (the deploy-event flow): the frozen offline-deploy contract
//    deliberately lets any active user deploy without holding the claim (two
//    offline crews may both deploy the same sign). See lib/deploy/contract.ts.
//  - lifecycle actions (delivered/handed_off/installed for external items): a
//    separate flow with its own FOR UPDATE re-check guard (H3), and the
//    documented VOLUNTEER route into handed_off/installed — which the lead-only
//    rule below would otherwise refuse.
// The `archived` rule is NOT part of that exemption and never was: it was
// carried out with it unintentionally, which is how a deploy event and a
// lifecycle action could each resurrect a soft-removed sign (#268/#269). It is
// therefore extracted below as `archivedRefusal`, so a path can enforce the
// archived rule without inheriting the claim / rank / category rules that would
// break its own contract.
//
// Call sites TODAY: this module, the lifecycle actions (#269), and `applyDeploys`
// (#268). All three archived-refusal paths are now closed.
//
// `applyDeploys` was the last one. Its write guard was `status: { not: "deployed" }`,
// which `archived` satisfies, so a queued deploy event resurrected a soft-removed
// sign. It is now guarded twice over: the event is refused against the pre-transaction
// read via `archivedRefusal` below, AND the guarded write excludes ARCHIVED_STATUS so
// the read→write race is closed at the database. It does NOT run the full
// `decideStatusChange` — that would refuse the unclaimed volunteer deploy its frozen
// contract exists to allow.
//
// (An earlier version of this note said the fix would arrive with audit Batch G,
// which owned lib/deploy/service.ts. Batch G merged on 2026-07-26 and did not touch
// the status guard; #268 was fixed on its own branch afterwards. Sequencing notes
// about other branches are not guarantees — state what the code does.)
//
// This module is PURE (no DB / no auth imports) so the security-critical decision
// is unit-testable in isolation; the DB lookups it depends on live in
// lib/sign-claims.ts.

import type { UserRole } from "@/app/generated/prisma/client";
import type { SignCategory, SignStatus } from "@/app/generated/prisma/enums";

import {
  ARCHIVED_STATUS,
  SIGN_STATUSES,
  isExternalCategory,
} from "@/app/(app)/signs/_lib";

const rankOf = (s: SignStatus): number =>
  (SIGN_STATUSES as readonly SignStatus[]).indexOf(s);
const isPrivileged = (role: UserRole): boolean =>
  role === "lead" || role === "admin";

// External-item terminal statuses. They rank above `deployed`, so a volunteer
// can't be allowed to reach them via the generic status path just because the
// move is "forward". The dedicated lifecycle actions are the volunteer route.
const LEAD_ONLY_TARGETS: readonly SignStatus[] = ["handed_off", "installed"];
export function isLeadOnlyStatusTarget(s: SignStatus): boolean {
  return LEAD_ONLY_TARGETS.includes(s);
}

export type StatusChangeDecision = { ok: true } | { ok: false; reason: string };

// The one message every path uses when it refuses to move a sign out of
// `archived`. Shared so the generic status path, the deploy-event flow and the
// external-item lifecycle actions all tell the operator the same story.
export const ARCHIVED_REFUSAL_REASON =
  "Restore this removed sign from the Removed view.";

// The `archived` clause of the policy, on its own. A soft-removed sign leaves
// `archived` ONLY through the dedicated, history-aware Restore action
// (lead-gated, in remove-actions.ts) — never a generic status change, a deploy
// event, or a lifecycle step. Returns the refusal, or null when the sign is not
// removed and the caller should carry on.
//
// Split out of decideStatusChange so the two paths that are exempt from the REST
// of that policy (applyDeploys, the lifecycle actions — see the header note) can
// still enforce this rule without inheriting the claim/rank/category rules that
// would break their own contracts. Takes a plain string because those callers
// read `status` straight off a raw row / locked SELECT.
export function archivedRefusal(
  currentStatus: string,
): { ok: false; reason: string } | null {
  return currentStatus === ARCHIVED_STATUS
    ? { ok: false, reason: ARCHIVED_REFUSAL_REASON }
    : null;
}

// Pure authorization decision for ONE sign status change. Callers supply
// `actorHoldsClaim` (only consulted for the `deployed` transition) and the sign's
// `category` (only consulted for the external-only terminal targets).
export function decideStatusChange(args: {
  role: UserRole;
  currentStatus: SignStatus;
  targetStatus: SignStatus;
  actorHoldsClaim: boolean;
  category: SignCategory;
}): StatusChangeDecision {
  // A soft-removed sign leaves `archived` ONLY through the dedicated, history-
  // aware Restore action (lead-gated, in remove-actions.ts) — never the generic
  // status path. Enforced BEFORE the privileged bypass so it holds for every
  // role and every caller that shares this policy (the single-sign action AND
  // the offline-sync API): a volunteer can't un-remove a sign, and a lead is
  // routed to Restore instead of silently bypassing its prior-status landing.
  // (`archived` isn't in SIGN_STATUSES, so rankOf is -1 and the backward-move
  // guard below would never catch it.)
  const archived = archivedRefusal(args.currentStatus);
  if (archived) return archived;

  // `handed_off` / `installed` belong to the external-item fork only. Enforced
  // BEFORE the privileged bypass (like the archived rule above) because the
  // failure this closes is a LEAD misclicking a terminal external status on an
  // easel/meterboard/socks sign from the generic dropdown: the stamps land but
  // the structured handoff record stays empty and LifecyclePanel — the only UI
  // that could complete or correct it — never renders for that class. (#232)
  if (
    isLeadOnlyStatusTarget(args.targetStatus) &&
    !isExternalCategory(args.category)
  ) {
    return {
      ok: false,
      reason:
        "Handed off / installed apply only to externally-installed items (banners, graphics, ops maps). Use the External item panel on the sign's detail page.",
    };
  }

  if (isPrivileged(args.role)) return { ok: true };

  if (rankOf(args.targetStatus) < rankOf(args.currentStatus)) {
    return { ok: false, reason: "Only a lead or admin can move a sign backward." };
  }

  if (isLeadOnlyStatusTarget(args.targetStatus)) {
    return { ok: false, reason: "Only a lead or admin can set this status." };
  }

  if (args.targetStatus === "deployed" && !args.actorHoldsClaim) {
    return {
      ok: false,
      reason: "You can only mark a sign deployed if your crew has claimed it.",
    };
  }

  return { ok: true };
}

// Statuses a volunteer may legally move FORWARD from to reach `target` (strictly
// lower rank — excludes the no-op target itself and every backward source).
//
// PREFILTER ONLY — never an authorization answer (#199). This encodes the RANK
// rule and nothing else: it does not know about `isLeadOnlyStatusTarget`
// (handed_off/installed are lead/admin-only), the `deployed`-requires-a-claim
// rule, or the external-category rule. Its job is to narrow a bulk `WHERE status
// IN (…)` cheaply at the DB level; every row that survives it MUST still be put
// through `decideStatusChange` before it is written. bulkSetStatus does exactly
// that, per-row, against the locked in-transaction read.
export function forwardSourceStatuses(target: SignStatus): SignStatus[] {
  const targetRank = rankOf(target);
  return SIGN_STATUSES.filter((_, i) => i < targetRank);
}
