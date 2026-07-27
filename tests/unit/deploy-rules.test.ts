import { describe, it, expect } from "vitest";

import {
  canCrewDeploy,
  hasUsableCrew,
} from "@/app/(app)/deploy/_lib/rules";
import type { DeploySignView } from "@/lib/deploy/contract";

function sign(over: Partial<DeploySignView> = {}): DeploySignView {
  return {
    id: 1,
    itemId: "A-101",
    signText: "Track 1",
    status: "sorted",
    zoneId: 3,
    zoneCode: "LVCC-L1",
    claimedByCrewId: 7,
    claimedByUserId: "u1",
    claimedAt: "2026-08-06T10:00:00.000Z",
    deployedAt: null,
    deployPhotoUrl: null,
    updatedAt: "2026-08-06T10:00:00.000Z",
    ...over,
  };
}

describe("canCrewDeploy", () => {
  it("allows a sorted sign claimed by the acting crew", () => {
    expect(canCrewDeploy(sign(), 7)).toBe(true);
  });

  it("rejects a sign another crew holds", () => {
    expect(canCrewDeploy(sign({ claimedByCrewId: 8 }), 7)).toBe(false);
  });

  it("rejects an unclaimed sign", () => {
    expect(canCrewDeploy(sign({ claimedByCrewId: null }), 7)).toBe(false);
  });

  it("rejects a sign that is already deployed", () => {
    // The #191 race: another device deployed it while our sheet was open.
    expect(canCrewDeploy(sign({ status: "deployed" }), 7)).toBe(false);
  });

  it("rejects a sign that left the sorted stage", () => {
    expect(canCrewDeploy(sign({ status: "archived" }), 7)).toBe(false);
  });

  it("rejects when there is no acting crew", () => {
    expect(canCrewDeploy(sign(), null)).toBe(false);
  });

  it("does not treat an unclaimed sign + no crew as a match", () => {
    // Guards against a null === null comparison passing the ownership check.
    expect(canCrewDeploy(sign({ claimedByCrewId: null }), null)).toBe(false);
  });

  it("rejects a missing sign", () => {
    expect(canCrewDeploy(null, 7)).toBe(false);
  });
});

describe("hasUsableCrew", () => {
  const known = (activeCrewId: number | null, myCrewIds: number[]) =>
    hasUsableCrew({ activeCrewId, myCrewIds, membershipKnown: true });

  it("accepts a remembered crew the user belongs to", () => {
    expect(known(7, [4, 7])).toBe(true);
  });

  it("rejects a remembered crew the user does not belong to", () => {
    // Shared/kiosk device: the previous volunteer's crew is still in localStorage.
    expect(known(7, [4, 5])).toBe(false);
  });

  it("rejects a remembered crew once the user belongs to none", () => {
    expect(known(7, [])).toBe(false);
  });

  it("rejects when nothing is remembered", () => {
    expect(known(null, [4, 7])).toBe(false);
  });

  it("trusts the remembered crew while membership is unknown (offline cold start)", () => {
    // bootstrap failed, so myCrewIds is empty for lack of data — NOT because the
    // volunteer has no crew. Vetoing here would break claiming on a dead floor.
    expect(
      hasUsableCrew({
        activeCrewId: 7,
        myCrewIds: [],
        membershipKnown: false,
      }),
    ).toBe(true);
  });

  it("still requires something to be remembered when membership is unknown", () => {
    expect(
      hasUsableCrew({
        activeCrewId: null,
        myCrewIds: [],
        membershipKnown: false,
      }),
    ).toBe(false);
  });
});
