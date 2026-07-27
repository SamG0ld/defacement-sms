import { describe, it, expect } from "vitest";

import {
  buildClaimResponse,
  classifyDeploys,
  deltaWindow,
  type SignClaimState,
} from "@/lib/deploy/resolve";
import type { DeployEventInput, DeploySignView } from "@/lib/deploy/contract";

const ev = (over: Partial<DeployEventInput> & Pick<DeployEventInput, "clientId" | "signId">): DeployEventInput => ({
  crewId: 1,
  deployedAt: new Date("2026-08-07T18:00:00.000Z"),
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

// #215: the delta cursor must never skip a row when the take() cap truncates the
// page. `updatedAt` is the only thing the cursor carries (it stays an ISO string
// on the wire), so a truncated page whose trailing timestamp group is only
// partly present has to be re-fetched next call rather than stepped over.
const view = (id: number, updatedAt: string): DeploySignView => ({
  id,
  itemId: `D-${id}`,
  signText: `Sign ${id}`,
  status: "sorted",
  zoneId: null,
  zoneCode: null,
  claimedByCrewId: null,
  claimedByUserId: null,
  claimedAt: null,
  deployedAt: null,
  deployPhotoUrl: null,
  updatedAt,
});

const T1 = "2026-08-07T18:00:00.000Z";
const T2 = "2026-08-07T18:00:01.000Z";
const T3 = "2026-08-07T18:00:02.000Z";

describe("deltaWindow — cursor that can't skip a row at the take cap (#215)", () => {
  it("an empty page yields no cursor (the caller keeps its own watermark)", () => {
    expect(deltaWindow([], 3)).toEqual({ views: [], cursor: null, capped: false });
  });

  it("under the cap: keeps every row and advances to the max updatedAt", () => {
    const views = [view(1, T1), view(2, T2)];
    const res = deltaWindow(views, 5);
    expect(res.views).toEqual(views);
    expect(res.cursor).toBe(T2);
    expect(res.capped).toBe(false);
  });

  it("flags a page that hit the cap so the caller can log it", () => {
    expect(deltaWindow([view(1, T1), view(2, T2)], 2).capped).toBe(true);
    expect(deltaWindow([view(1, T1), view(2, T2)], 3).capped).toBe(false);
  });

  it("at the cap: drops the (possibly partial) trailing timestamp group so the next call re-fetches it", () => {
    // T3 is the boundary group — rows 3 and 4 are in this page, but a 5th row at
    // T3 may have been cut off by the cap, so T3 must not be stepped over.
    const res = deltaWindow([view(1, T1), view(2, T2), view(3, T3), view(4, T3)], 4);
    expect(res.views.map((v) => v.id)).toEqual([1, 2]);
    expect(res.cursor).toBe(T2);
  });

  it("at the cap with a single trailing row: still re-fetches that row's timestamp", () => {
    const res = deltaWindow([view(1, T1), view(2, T2), view(3, T3)], 3);
    expect(res.views.map((v) => v.id)).toEqual([1, 2]);
    expect(res.cursor).toBe(T2);
  });

  it("degenerate: a full page sharing ONE timestamp still advances (progress beats the theoretical gap)", () => {
    // Trimming would empty the page and pin the cursor forever, so the whole page
    // is returned and the cursor advances past that timestamp.
    const res = deltaWindow([view(1, T1), view(2, T1), view(3, T1)], 3);
    expect(res.views.map((v) => v.id)).toEqual([1, 2, 3]);
    expect(res.cursor).toBe(T1);
  });

  it("never returns a cursor older than the newest row it kept", () => {
    const res = deltaWindow([view(1, T1), view(2, T2), view(3, T3)], 3);
    const kept = res.views.map((v) => v.updatedAt);
    expect(res.cursor).toBe(kept[kept.length - 1]);
  });
});
