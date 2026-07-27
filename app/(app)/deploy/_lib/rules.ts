// Pure decision rules for the floor tool's UI. Kept out of the components so the
// same rule can't drift between the two places that ask it, and so it's testable
// in the pure-Node unit env.

import type { DeploySignView } from "@/lib/deploy/contract";

// Can the acting crew mark this sign deployed right now? The server is still the
// authority (lib/deploy/service.ts), but the UI must not OFFER — or enqueue — a
// deploy the server will reject. Used both to gate the preview pane's Deploy
// button and to re-check at confirm time against live store state (#191).
export function canCrewDeploy(
  sign: DeploySignView | null,
  activeCrewId: number | null,
): boolean {
  return (
    !!sign &&
    sign.status === "sorted" &&
    sign.claimedByCrewId !== null &&
    sign.claimedByCrewId === activeCrewId
  );
}

// Is the device's remembered crew one this user actually belongs to (#189)?
//
// `activeCrewId` is a device-local choice persisted to a NON user-scoped
// localStorage key, so it outlives the user who picked it — a shared/kiosk phone
// handed to the next volunteer leaves a stale id driving the claim UI.
//
// `membershipKnown` is the load-bearing part. On an offline cold start the
// bootstrap fetch fails and `myCrewIds` is simply empty — not "you're in no
// crews". Gating on the list in that state would strip the claim controls from a
// legitimately-crewed volunteer with no signal, which is precisely the situation
// this tool exists for. So an unknown membership trusts the remembered crew, and
// only a KNOWN membership can veto it.
//
// Scope, precisely: "known" means known AS OF THE LAST BOOTSTRAP. `myCrewIds` is
// refreshed by bootstrap only (mount, createCrew, joinCrew) — never by the 20s
// background sync — so a crew deactivated mid-session isn't seen until a reload.
// This is a UX affordance, not an authorization boundary: the server independently
// enforces membership on claim/release (assertMember in lib/deploy/service.ts).
export function hasUsableCrew({
  activeCrewId,
  myCrewIds,
  membershipKnown,
}: {
  activeCrewId: number | null;
  myCrewIds: number[];
  membershipKnown: boolean;
}): boolean {
  if (activeCrewId === null) return false;
  if (!membershipKnown) return true;
  return myCrewIds.includes(activeCrewId);
}
