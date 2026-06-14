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
//
// Out of scope (intentionally NOT routed through this policy):
//  - `applyDeploys` (the deploy-event flow): the frozen offline-deploy contract
//    deliberately lets any active user deploy without holding the claim (two
//    offline crews may both deploy the same sign). See lib/deploy/contract.ts.
//  - lifecycle actions (delivered/handed_off/installed for external items): a
//    separate flow with its own FOR UPDATE re-check guard (H3).
//
// This module is PURE (no DB / no auth imports) so the security-critical decision
// is unit-testable in isolation; the DB lookups it depends on live in
// lib/sign-claims.ts.

import type { UserRole } from "@/app/generated/prisma/client";
import type { SignStatus } from "@/app/generated/prisma/enums";

import { SIGN_STATUSES } from "@/app/(app)/signs/_lib";

const rankOf = (s: SignStatus): number => SIGN_STATUSES.indexOf(s);
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

// Pure authorization decision for ONE sign status change. Callers supply
// `actorHoldsClaim` (only consulted for the `deployed` transition).
export function decideStatusChange(args: {
  role: UserRole;
  currentStatus: SignStatus;
  targetStatus: SignStatus;
  actorHoldsClaim: boolean;
}): StatusChangeDecision {
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
// lower rank — excludes the no-op target itself and every backward source). Used
// to filter the bulk path down to eligible rows at the DB level.
export function forwardSourceStatuses(target: SignStatus): SignStatus[] {
  const targetRank = rankOf(target);
  return SIGN_STATUSES.filter((_, i) => i < targetRank);
}
