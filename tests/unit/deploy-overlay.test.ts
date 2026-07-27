import { describe, it, expect } from "vitest";

import { applyOutboxOverlay } from "@/app/(app)/deploy/_lib/overlay";
import type { OutboxEntry } from "@/app/(app)/deploy/_lib/types";
import type { DeploySignView } from "@/lib/deploy/contract";

const ME = "user-me";

const sign = (over: Partial<DeploySignView> = {}): DeploySignView => ({
  id: 1,
  itemId: "A-001",
  signText: "Track 1",
  status: "sorted",
  zoneId: null,
  zoneCode: null,
  claimedByCrewId: null,
  claimedByUserId: null,
  claimedAt: null,
  deployedAt: null,
  deployPhotoUrl: null,
  updatedAt: "2026-08-07T00:00:00.000Z",
  ...over,
});

const map = (...signs: DeploySignView[]): Record<number, DeploySignView> =>
  Object.fromEntries(signs.map((s) => [s.id, s]));

const claim = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientId: "c1",
  kind: "claim",
  payload: { crewId: 7, signIds: [1] },
  status: "pending",
  attempts: 0,
  createdAt: 100,
  ...over,
});

const deploy = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientId: "d1",
  kind: "deploy",
  payload: { signId: 1, crewId: 7, deployedAt: "2026-08-07T18:00:00.000Z" },
  status: "pending",
  attempts: 0,
  createdAt: 200,
  ...over,
});

describe("applyOutboxOverlay — replaying queued work over server truth (#184)", () => {
  it("re-applies a pending claim that the server snapshot doesn't know about", () => {
    const res = applyOutboxOverlay(map(sign()), [claim()], ME);
    expect(res[1].claimedByCrewId).toBe(7);
    expect(res[1].claimedByUserId).toBe(ME);
  });

  it("re-applies a pending deploy, consuming the claim lock", () => {
    const res = applyOutboxOverlay(
      map(sign({ claimedByCrewId: 7, claimedByUserId: ME })),
      [deploy()],
      ME,
    );
    expect(res[1].status).toBe("deployed");
    expect(res[1].deployedAt).toBe("2026-08-07T18:00:00.000Z");
    expect(res[1].claimedByCrewId).toBeNull();
    expect(res[1].claimedByUserId).toBeNull();
  });

  it("uses the ENQUEUED deploy instant, so replaying doesn't drift the timestamp", () => {
    const entries = [deploy({ payload: { signId: 1, crewId: 7, deployedAt: "2026-08-07T18:00:00.000Z" } })];
    const once = applyOutboxOverlay(map(sign()), entries, ME);
    const twice = applyOutboxOverlay(map(sign()), entries, ME);
    expect(once[1].deployedAt).toBe(twice[1].deployedAt);
  });

  it("applies a claim THEN its deploy in createdAt order", () => {
    // Deploy listed first, but its createdAt is later — order must come from the
    // timestamps, not array position (the drain sorts by rank, not createdAt).
    const res = applyOutboxOverlay(
      map(sign()),
      [deploy({ createdAt: 200 }), claim({ createdAt: 100 })],
      ME,
    );
    expect(res[1].status).toBe("deployed");
    expect(res[1].claimedByCrewId).toBeNull(); // deploy consumed the claim
  });

  it("releases only a sign this crew actually holds", () => {
    const release = claim({
      clientId: "r1",
      kind: "release",
      payload: { crewId: 7, signIds: [1, 2] },
    });
    const res = applyOutboxOverlay(
      map(
        sign({ id: 1, claimedByCrewId: 7 }),
        sign({ id: 2, claimedByCrewId: 9 }), // another crew's — untouched
      ),
      [release],
      ME,
    );
    expect(res[1].claimedByCrewId).toBeNull();
    expect(res[2].claimedByCrewId).toBe(9);
  });

  describe("guards — never show something the server would reject", () => {
    it("won't claim a sign another crew already holds", () => {
      const res = applyOutboxOverlay(
        map(sign({ claimedByCrewId: 9, claimedByUserId: "someone-else" })),
        [claim()],
        ME,
      );
      expect(res[1].claimedByCrewId).toBe(9);
    });

    it("won't claim a sign that isn't sorted yet (claiming is post-sort only)", () => {
      const res = applyOutboxOverlay(map(sign({ status: "staged" })), [claim()], ME);
      expect(res[1].claimedByCrewId).toBeNull();
    });

    it("ignores entries for signs absent from the snapshot", () => {
      const res = applyOutboxOverlay(map(sign({ id: 99 })), [claim()], ME);
      expect(res[99].claimedByCrewId).toBeNull();
      expect(res[1]).toBeUndefined();
    });

    it("does NOT apply dead-lettered (failed) entries — they'll never reach the server", () => {
      const res = applyOutboxOverlay(
        map(sign()),
        [claim({ status: "failed" }), deploy({ status: "failed" })],
        ME,
      );
      expect(res[1].claimedByCrewId).toBeNull();
      expect(res[1].status).toBe("sorted");
    });

    it("photo entries have no sign-visible effect", () => {
      const photo = claim({
        clientId: "p1",
        kind: "photo",
        payload: { signId: 1, deployClientId: "d1" },
      });
      expect(applyOutboxOverlay(map(sign()), [photo], ME)[1]).toEqual(sign());
    });
  });

  it("returns the input untouched when nothing is pending (no needless re-render)", () => {
    const signs = map(sign());
    expect(applyOutboxOverlay(signs, [], ME)).toBe(signs);
  });

  it("does not mutate the input snapshot", () => {
    const signs = map(sign());
    applyOutboxOverlay(signs, [claim()], ME);
    expect(signs[1].claimedByCrewId).toBeNull();
  });
});
