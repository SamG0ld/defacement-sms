import { describe, it, expect } from "vitest";

import {
  buildClaimResponse,
  classifyDeploys,
  type SignClaimState,
} from "@/lib/deploy/resolve";
import type { DeployEventInput } from "@/lib/deploy/contract";

const ev = (over: Partial<DeployEventInput> & Pick<DeployEventInput, "clientId" | "signId">): DeployEventInput => ({
  crewId: 1,
  deployedAt: new Date("2026-08-07T18:00:00.000Z"),
  hasPhoto: false,
  ...over,
});

describe("buildClaimResponse — exclusive lock", () => {
  it("grants the ids the UPDATE locked", () => {
    const res = buildClaimResponse([1, 2, 3], 10, [1, 2, 3], new Map());
    expect(res.granted).toEqual([1, 2, 3]);
    expect(res.rejected).toEqual([]);
  });

  it("rejects a sign held by another crew with byCrewId", () => {
    const state = new Map<number, SignClaimState>([
      [2, { status: "sorted", claimedByCrewId: 99 }],
    ]);
    const res = buildClaimResponse([1, 2], 10, [1], state);
    expect(res.granted).toEqual([1]);
    expect(res.rejected).toEqual([
      { signId: 2, reason: "already_claimed", byCrewId: 99 },
    ]);
  });

  it("treats a sign already held by THIS crew as granted (idempotent re-claim)", () => {
    const state = new Map<number, SignClaimState>([
      [5, { status: "sorted", claimedByCrewId: 10 }],
    ]);
    const res = buildClaimResponse([5], 10, [], state);
    expect(res.granted).toEqual([5]);
    expect(res.rejected).toEqual([]);
  });

  it("rejects a non-sorted sign as not_sorted", () => {
    const state = new Map<number, SignClaimState>([
      [7, { status: "delivered", claimedByCrewId: null }],
    ]);
    const res = buildClaimResponse([7], 10, [], state);
    expect(res.rejected).toEqual([
      { signId: 7, reason: "not_sorted", byCrewId: null },
    ]);
  });

  it("rejects an unknown sign as not_found", () => {
    const res = buildClaimResponse([42], 10, [], new Map());
    expect(res.rejected).toEqual([
      { signId: 42, reason: "not_found", byCrewId: null },
    ]);
  });

  it("classifies a residual sorted+unclaimed miss as a transient already_claimed", () => {
    const state = new Map<number, SignClaimState>([
      [8, { status: "sorted", claimedByCrewId: null }],
    ]);
    const res = buildClaimResponse([8], 10, [], state);
    expect(res.rejected).toEqual([
      { signId: 8, reason: "already_claimed", byCrewId: null },
    ]);
  });

  it("de-dupes repeated requested ids, preserving first-seen order", () => {
    const res = buildClaimResponse([3, 1, 3, 1], 10, [1, 3], new Map());
    expect(res.granted).toEqual([3, 1]);
  });
});

describe("classifyDeploys — idempotency + conflict", () => {
  it("applies a fresh deploy", () => {
    const c = classifyDeploys([ev({ clientId: "a", signId: 1 })], new Set(), new Set());
    expect(c.toApply.map((e) => e.signId)).toEqual([1]);
    expect(c.toLogConflict).toEqual([]);
    expect(c.results).toEqual([{ clientId: "a", signId: 1, status: "applied" }]);
  });

  it("marks a previously-processed clientId as a duplicate (no-op)", () => {
    const c = classifyDeploys(
      [ev({ clientId: "a", signId: 1 })],
      new Set(["a"]),
      new Set(),
    );
    expect(c.toApply).toEqual([]);
    expect(c.results).toEqual([{ clientId: "a", signId: 1, status: "duplicate" }]);
  });

  it("marks a deploy of an already-deployed sign as a conflict (logged, not applied)", () => {
    const c = classifyDeploys(
      [ev({ clientId: "b", signId: 1 })],
      new Set(),
      new Set([1]),
    );
    expect(c.toApply).toEqual([]);
    expect(c.toLogConflict.map((e) => e.clientId)).toEqual(["b"]);
    expect(c.results).toEqual([{ clientId: "b", signId: 1, status: "conflict" }]);
  });

  it("within a batch, the first event for a sign wins; later ones conflict", () => {
    const c = classifyDeploys(
      [ev({ clientId: "a", signId: 1 }), ev({ clientId: "b", signId: 1 })],
      new Set(),
      new Set(),
    );
    expect(c.toApply.map((e) => e.clientId)).toEqual(["a"]);
    expect(c.toLogConflict.map((e) => e.clientId)).toEqual(["b"]);
    expect(c.results).toEqual([
      { clientId: "a", signId: 1, status: "applied" },
      { clientId: "b", signId: 1, status: "conflict" },
    ]);
  });

  it("treats a repeated clientId within the same batch as a duplicate", () => {
    const c = classifyDeploys(
      [ev({ clientId: "a", signId: 1 }), ev({ clientId: "a", signId: 1 })],
      new Set(),
      new Set(),
    );
    expect(c.toApply).toHaveLength(1);
    expect(c.results[1]).toEqual({ clientId: "a", signId: 1, status: "duplicate" });
  });
});
