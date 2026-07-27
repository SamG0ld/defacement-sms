import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  drainOutbox,
  pruneDeadLetters,
  syncOnce,
} from "@/app/(app)/deploy/_lib/sync";
import { MAX_DEAD_LETTERS } from "@/lib/offline/dead-letter";
import {
  ApiHttpError,
  NetworkError,
  getChanges,
  postClaim,
  postDeploy,
  postPhoto,
  postRelease,
} from "@/app/(app)/deploy/_lib/api";
import {
  allEntries,
  deleteEntry,
  deletePhoto,
  getPhoto,
  putEntry,
} from "@/app/(app)/deploy/_lib/idb";
import type { OutboxEntry } from "@/app/(app)/deploy/_lib/types";

// Keep the real NetworkError / ApiHttpError classes (processEntry does
// `instanceof`), but replace the network calls with spies.
vi.mock("@/app/(app)/deploy/_lib/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/(app)/deploy/_lib/api")>();
  return {
    ...actual,
    postClaim: vi.fn(),
    postRelease: vi.fn(),
    postDeploy: vi.fn(),
    postPhoto: vi.fn(),
    getChanges: vi.fn(),
  };
});

// The IndexedDB layer is fully stubbed — sync logic is pure given these.
vi.mock("@/app/(app)/deploy/_lib/idb", () => ({
  allEntries: vi.fn(),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
  deletePhoto: vi.fn().mockResolvedValue(undefined),
  getPhoto: vi.fn(),
  putEntry: vi.fn().mockResolvedValue(undefined),
}));

const claimEntry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientId: "c1",
  kind: "claim",
  payload: { crewId: 1, signIds: [1] },
  status: "pending",
  attempts: 0,
  createdAt: 100,
  ...over,
});

const deployEntry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientId: "d1",
  kind: "deploy",
  payload: {
    signId: 1,
    crewId: 1,
    deployedAt: "2026-08-07T18:00:00.000Z",
  },
  status: "pending",
  attempts: 0,
  createdAt: 200,
  ...over,
});

const photoEntry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientId: "p1",
  kind: "photo",
  payload: { signId: 1, deployClientId: "d1" },
  status: "pending",
  attempts: 0,
  createdAt: 50,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults; individual tests override.
  vi.mocked(postClaim).mockResolvedValue({ granted: [], rejected: [] });
  vi.mocked(postDeploy).mockResolvedValue({ results: [] });
  vi.mocked(postPhoto).mockResolvedValue({
    clientId: "d1",
    photoUrl: "/x",
    cachedOnSign: true,
  });
  vi.mocked(getPhoto).mockResolvedValue(
    new Blob(["x"], { type: "image/png" }),
  );
});

describe("drainOutbox — ordering", () => {
  it("drains claim/deploy (rank 0) before photo (rank 1), regardless of createdAt", async () => {
    const order: string[] = [];
    vi.mocked(postDeploy).mockImplementation(async () => {
      order.push("deploy");
      return { results: [] };
    });
    vi.mocked(postPhoto).mockImplementation(async () => {
      order.push("photo");
      return { clientId: "d1", photoUrl: "/x", cachedOnSign: true };
    });
    // photo has the EARLIER createdAt but must still drain last.
    vi.mocked(allEntries).mockResolvedValue([
      photoEntry({ createdAt: 50 }),
      deployEntry({ createdAt: 200 }),
    ]);

    await drainOutbox();
    expect(order).toEqual(["deploy", "photo"]);
  });
});

describe("drainOutbox — outcomes", () => {
  it("ok: deletes the entry and counts it drained", async () => {
    vi.mocked(allEntries).mockResolvedValue([claimEntry()]);
    const res = await drainOutbox();
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(res.drained).toBe(1);
    expect(res.stoppedOffline).toBe(false);
  });

  it("release: posts the release and drains the entry", async () => {
    vi.mocked(postRelease).mockResolvedValue({ released: [1] });
    vi.mocked(allEntries).mockResolvedValue([
      {
        ...claimEntry({ clientId: "r1" }),
        kind: "release",
        payload: { crewId: 1, signIds: [1] },
      },
    ]);
    const res = await drainOutbox();
    expect(postRelease).toHaveBeenCalledWith({
      clientId: "r1",
      crewId: 1,
      signIds: [1],
    });
    expect(deleteEntry).toHaveBeenCalledWith("r1");
    expect(res.drained).toBe(1);
  });

  it("NetworkError: stops the drain offline, leaves the entry pending", async () => {
    vi.mocked(postClaim).mockRejectedValue(new NetworkError("offline"));
    vi.mocked(allEntries).mockResolvedValue([
      claimEntry({ clientId: "c1", createdAt: 1 }),
      claimEntry({ clientId: "c2", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.authExpired).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
    // Broke after the first failure — never tried the second entry.
    expect(postClaim).toHaveBeenCalledTimes(1);
  });

  it("401: flags authExpired and stops WITHOUT marking offline", async () => {
    vi.mocked(postClaim).mockRejectedValue(new ApiHttpError(401, "expired"));
    vi.mocked(allEntries).mockResolvedValue([claimEntry()]);
    const res = await drainOutbox();
    expect(res.authExpired).toBe(true);
    expect(res.stoppedOffline).toBe(false);
    expect(res.drained).toBe(0);
  });

  it("photo + 404: dead-letters immediately and drops the bytes (deploy never landed)", async () => {
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([photoEntry()]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(res.stoppedOffline).toBe(false);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", clientId: "p1" }),
    );
    expect(deletePhoto).toHaveBeenCalledWith("d1"); // PII bytes discarded
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("photo + permanent 4xx (400 invalid image): dead-letters AND drops the bytes (no lingering PII)", async () => {
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(400, "invalid image"));
    vi.mocked(allEntries).mockResolvedValue([photoEntry()]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", clientId: "p1" }),
    );
    // PII (badge/face) bytes must not linger at rest on a shared device.
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });

  it("permanent 4xx (422): dead-letters and continues with the rest", async () => {
    vi.mocked(postClaim)
      .mockRejectedValueOnce(new ApiHttpError(422, "bad"))
      .mockResolvedValueOnce({ granted: [2], rejected: [] });
    vi.mocked(allEntries).mockResolvedValue([
      claimEntry({ clientId: "c1", createdAt: 1 }),
      claimEntry({ clientId: "c2", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", clientId: "c1" }),
    );
    // Did NOT break — the second entry still drained.
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(res.drained).toBe(1);
  });

  it("429: transient stop (no dead-letter)", async () => {
    vi.mocked(postClaim).mockRejectedValue(new ApiHttpError(429, "slow down"));
    vi.mocked(allEntries).mockResolvedValue([claimEntry()]);
    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.deadLettered).toBe(0);
    expect(putEntry).not.toHaveBeenCalled();
  });

  it("missing photo bytes: treated as ok (already uploaded / evicted), entry dropped", async () => {
    vi.mocked(getPhoto).mockResolvedValue(undefined);
    vi.mocked(allEntries).mockResolvedValue([photoEntry()]);
    const res = await drainOutbox();
    expect(postPhoto).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith("p1");
    expect(res.drained).toBe(1);
  });

  it("photo upload: records the returned photoUrl for the store to apply (#100)", async () => {
    vi.mocked(postPhoto).mockResolvedValue({
      clientId: "d1",
      photoUrl: "/api/native/photos/sign/7",
      cachedOnSign: true,
    });
    vi.mocked(allEntries).mockResolvedValue([
      photoEntry({ payload: { signId: 7, deployClientId: "d1" } }),
    ]);
    const res = await drainOutbox();
    expect(postPhoto).toHaveBeenCalled();
    expect(res.photoApplied).toEqual([
      { signId: 7, photoUrl: "/api/native/photos/sign/7" },
    ]);
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });

  // #231: the upload succeeded and the photo is kept on the deploy event, but the
  // sign's photo belongs to the deploy that won the race — so the optimistic
  // overlay must be skipped rather than showing this crew's photo on the sign.
  it("photo upload for a losing deploy: succeeds but does not overlay it on the sign (#231)", async () => {
    vi.mocked(postPhoto).mockResolvedValue({
      clientId: "d1",
      photoUrl: "/api/native/deploys/d1/photo",
      cachedOnSign: false,
    });
    vi.mocked(allEntries).mockResolvedValue([
      photoEntry({ payload: { signId: 7, deployClientId: "d1" } }),
    ]);
    const res = await drainOutbox();
    expect(res.photoApplied).toEqual([]);
    // Still a clean drain — the entry resolves instead of retrying forever.
    expect(res.drained).toBe(1);
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });
});

describe("drainOutbox — deploy batching", () => {
  it("posts consecutive deploys as ONE batch and drains them all", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [
        { clientId: "d1", signId: 1, status: "applied" },
        { clientId: "d2", signId: 2, status: "applied" },
        { clientId: "d3", signId: 3, status: "duplicate" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2, payload: { signId: 2, crewId: 1, deployedAt: "2026-08-07T18:00:00.000Z" } }),
      deployEntry({ clientId: "d3", createdAt: 3, payload: { signId: 3, crewId: 1, deployedAt: "2026-08-07T18:00:00.000Z" } }),
    ]);

    const res = await drainOutbox();
    expect(postDeploy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postDeploy).mock.calls[0][0].events).toHaveLength(3);
    // #102: the client no longer sends the server-ignored `hasPhoto` on the wire
    // (all three come from the same factory, so check each).
    for (const e of vi.mocked(postDeploy).mock.calls[0][0].events) {
      expect(e).not.toHaveProperty("hasPhoto");
    }
    expect(res.drained).toBe(3);
    expect(deleteEntry).toHaveBeenCalledWith("d1");
    expect(deleteEntry).toHaveBeenCalledWith("d2");
    expect(deleteEntry).toHaveBeenCalledWith("d3");
  });

  it("a claim between deploys breaks the run (FIFO claim→deploy order preserved)", async () => {
    const order: string[] = [];
    vi.mocked(postDeploy).mockImplementation(async (req) => {
      order.push(`deploy:${req.events.map((e) => e.clientId).join(",")}`);
      return {
        results: req.events.map((e) => ({
          clientId: e.clientId,
          signId: e.signId,
          status: "applied" as const,
        })),
      };
    });
    vi.mocked(postClaim).mockImplementation(async () => {
      order.push("claim");
      return { granted: [], rejected: [] };
    });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      claimEntry({ clientId: "c1", createdAt: 2 }),
      deployEntry({ clientId: "d2", createdAt: 3 }),
    ]);

    const res = await drainOutbox();
    expect(order).toEqual(["deploy:d1", "claim", "deploy:d2"]);
    expect(res.drained).toBe(3);
  });

  it("surfaces conflicts from the batched results and still drains those entries", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [
        { clientId: "d1", signId: 1, status: "applied" },
        { clientId: "d2", signId: 9, status: "conflict" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    expect(res.deployConflicts).toEqual([9]);
    expect(res.drained).toBe(2);
  });

  it("falls back to per-entry on a batch-level 4xx so only the offender dead-letters", async () => {
    vi.mocked(postDeploy)
      // The batch POST fails permanently…
      .mockRejectedValueOnce(new ApiHttpError(422, "bad event"))
      // …then per-entry replay: first ok, second the actual offender.
      .mockResolvedValueOnce({
        results: [{ clientId: "d1", signId: 1, status: "applied" }],
      })
      .mockRejectedValueOnce(new ApiHttpError(422, "bad event"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    expect(postDeploy).toHaveBeenCalledTimes(3);
    expect(res.drained).toBe(1);
    expect(res.deadLettered).toBe(1);
    expect(deleteEntry).toHaveBeenCalledWith("d1");
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", clientId: "d2" }),
    );
  });

  it("leaves an entry pending when the server didn't echo its result", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [{ clientId: "d1", signId: 1, status: "applied" }],
    });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    expect(res.drained).toBe(1);
    expect(deleteEntry).toHaveBeenCalledWith("d1");
    expect(deleteEntry).not.toHaveBeenCalledWith("d2");
  });

  it("stops the whole drain when the batch hits a NetworkError", async () => {
    vi.mocked(postDeploy).mockRejectedValue(new NetworkError("offline"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });
});

describe("drainOutbox — server feedback accumulates", () => {
  it("collects claim rejections", async () => {
    vi.mocked(postClaim).mockResolvedValue({
      granted: [],
      rejected: [{ signId: 2, reason: "already_claimed", byCrewId: 9 }],
    });
    vi.mocked(allEntries).mockResolvedValue([claimEntry()]);
    const res = await drainOutbox();
    expect(res.claimRejections).toEqual([
      { signId: 2, reason: "already_claimed", byCrewId: 9 },
    ]);
  });

  it("collects deploy conflicts (sign already deployed by another crew)", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [{ clientId: "d1", signId: 5, status: "conflict" }],
    });
    vi.mocked(allEntries).mockResolvedValue([deployEntry()]);
    const res = await drainOutbox();
    expect(res.deployConflicts).toEqual([5]);
  });

  // The counts are shown to the user ("N sign(s) were already deployed by another
  // crew"), so the same sign observed twice across the per-entry replay path must
  // not inflate them. (#204)
  it("reports each conflicted signId ONCE across a per-entry replay (#204)", async () => {
    vi.mocked(postDeploy)
      // Batch POST fails permanently → per-entry replay of both entries…
      .mockRejectedValueOnce(new ApiHttpError(422, "bad event"))
      // …and BOTH per-entry replays report a conflict on the SAME sign.
      .mockResolvedValueOnce({
        results: [{ clientId: "d1", signId: 5, status: "conflict" }],
      })
      .mockResolvedValueOnce({
        results: [{ clientId: "d2", signId: 5, status: "conflict" }],
      });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      deployEntry({ clientId: "d2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    expect(res.deployConflicts).toEqual([5]); // not [5, 5]
    expect(res.drained).toBe(2);
  });

  it("reports each rejected signId ONCE even if two claim entries hit it (#204)", async () => {
    vi.mocked(postClaim).mockResolvedValue({
      granted: [],
      rejected: [{ signId: 2, reason: "already_claimed", byCrewId: 9 }],
    });
    vi.mocked(allEntries).mockResolvedValue([
      claimEntry({ clientId: "c1", createdAt: 1 }),
      claimEntry({ clientId: "c2", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.claimRejections).toEqual([
      { signId: 2, reason: "already_claimed", byCrewId: 9 },
    ]);
  });
});

// A photo 404 means "no deploy event server-side". That's only PERMANENT once the
// deploy is actually gone — if the deploy is still pending (the server didn't echo
// it), it will retry and succeed next drain, and discarding the bytes now would
// leave the deployed sign permanently photo-less. (#246)
describe("drainOutbox — photo 404 vs. a still-pending deploy (#246)", () => {
  it("keeps the photo pending and KEEPS its bytes when the deploy is still pending", async () => {
    // Server echoes nothing → the deploy entry stays pending (sync.ts leaves it).
    vi.mocked(postDeploy).mockResolvedValue({ results: [] });
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      photoEntry({
        clientId: "p1",
        createdAt: 2,
        payload: { signId: 1, deployClientId: "d1" },
      }),
    ]);

    const res = await drainOutbox();
    // Photo neither drained nor dead-lettered — it just waits.
    expect(res.deadLettered).toBe(0);
    expect(res.stoppedOffline).toBe(false); // the drain continued; network is fine
    expect(deletePhoto).not.toHaveBeenCalled(); // bytes preserved for the retry
    expect(putEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "p1", status: "failed" }),
    );
    expect(deleteEntry).not.toHaveBeenCalledWith("p1");
  });

  it("still dead-letters + discards bytes when the deploy DID resolve this drain", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [{ clientId: "d1", signId: 1, status: "applied" }],
    });
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      photoEntry({
        clientId: "p1",
        createdAt: 2,
        payload: { signId: 1, deployClientId: "d1" },
      }),
    ]);

    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });

  it("still dead-letters + discards bytes when the deploy isn't in the outbox at all", async () => {
    // The normal case: the deploy drained in an EARLIER pass and is long gone.
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([photoEntry()]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });
});

describe("syncOnce — drain then pull delta", () => {
  it("composes the drain result with the changes pull", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockResolvedValue({
      cursor: "cursor-2",
      signs: [{ id: 1 } as never],
    });
    const res = await syncOnce("cursor-1");
    expect(allEntries).toHaveBeenCalled(); // drained before pulling the delta
    expect(getChanges).toHaveBeenCalledWith("cursor-1");
    expect(res.cursor).toBe("cursor-2");
    expect(res.changedSigns).toEqual([{ id: 1 }]);
    expect(res.drained).toBe(0);
  });

  // syncOnce is TOTAL for pull failures: it classifies them into `pullError` and
  // RETURNS, so the store keeps every side-effect the (already-completed) drain
  // produced instead of losing it to a throw. (#183)
  it("reports a getChanges NetworkError as pullError instead of throwing", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockRejectedValue(new NetworkError("dropped"));
    const res = await syncOnce("cursor-1");
    expect(res.pullError).toEqual({ kind: "network" });
    expect(res.cursor).toBe("cursor-1"); // cursor NOT advanced
    expect(res.changedSigns).toEqual([]);
  });

  it("keeps ALL completed-drain side-effects when the delta pull 401s (#183)", async () => {
    vi.mocked(postDeploy).mockResolvedValue({
      results: [{ clientId: "d1", signId: 5, status: "conflict" }],
    });
    vi.mocked(postPhoto).mockResolvedValue({
      clientId: "d9",
      photoUrl: "/api/native/photos/sign/7",
      // The sign's photo cache was written by this deploy, so the drain surfaces
      // it — which is what the photoApplied assertion below depends on (#231).
      cachedOnSign: true,
    });
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      photoEntry({
        clientId: "p1",
        createdAt: 2,
        payload: { signId: 7, deployClientId: "d9" },
      }),
    ]);
    vi.mocked(getChanges).mockRejectedValue(new ApiHttpError(401, "expired"));

    const res = await syncOnce("cursor-1");
    // The push half fully succeeded — none of it may be discarded.
    expect(res.pullError).toEqual({ kind: "auth-expired" });
    expect(res.photoApplied).toEqual([
      { signId: 7, photoUrl: "/api/native/photos/sign/7" },
    ]);
    expect(res.deployConflicts).toEqual([5]);
    expect(res.drained).toBe(2);
    // The photo BYTES are already gone from IDB — this result is their only record.
    expect(deletePhoto).toHaveBeenCalledWith("d9");
  });

  it("classifies a 403 pull as forbidden and a 429/5xx as retryable", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockRejectedValueOnce(new ApiHttpError(403, "revoked"));
    expect((await syncOnce("c")).pullError).toEqual({ kind: "forbidden" });
    vi.mocked(getChanges).mockRejectedValueOnce(new ApiHttpError(429, "slow"));
    expect((await syncOnce("c")).pullError).toEqual({ kind: "rate-limited" });
    vi.mocked(getChanges).mockRejectedValueOnce(new ApiHttpError(503, "down"));
    expect((await syncOnce("c")).pullError).toEqual({ kind: "transient" });
  });

  // A non-empty but garbage cursor 400s forever with no recovery path; the store
  // uses this classification to re-bootstrap a fresh cursor. (#208)
  it("classifies a permanent 4xx pull so the store can re-bootstrap a poisoned cursor (#208)", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockRejectedValue(new ApiHttpError(400, "bad since"));
    const res = await syncOnce("garbage-cursor");
    expect(res.pullError).toEqual({ kind: "permanent" });
    expect(res.cursor).toBe("garbage-cursor");
  });

  it("reports no pullError on a clean pass", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockResolvedValue({ cursor: "c2", signs: [] });
    expect((await syncOnce("c1")).pullError).toBeUndefined();
  });

  it("skips the delta pull when the cursor is empty (pre-bootstrap) — drains only (#66)", async () => {
    vi.mocked(allEntries).mockResolvedValue([claimEntry()]);
    const res = await syncOnce("");
    // The drain still ran (the claim was posted AND removed from the outbox)…
    expect(postClaim).toHaveBeenCalledTimes(1);
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(res.drained).toBe(1);
    // …but the changes endpoint (which requires a `since`) was NOT called.
    expect(getChanges).not.toHaveBeenCalled();
    expect(res.cursor).toBe("");
    expect(res.changedSigns).toEqual([]);
  });
});

// Mirrors the /signs twin: dead-letters are never pruned, so a shared floor
// device accumulates them across a multi-day con. Photo dead-letters already drop
// their bytes at dead-letter time; pruning re-checks so no PII (badges/faces) is
// left orphaned at rest on a shared device. (#207)
describe("pruneDeadLetters — bounds the dead-letter pile (#207)", () => {
  const failedClaims = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      claimEntry({ clientId: `f${i}`, status: "failed", createdAt: i }),
    );

  it("deletes nothing while at or under the cap", async () => {
    vi.mocked(allEntries).mockResolvedValue(failedClaims(MAX_DEAD_LETTERS));
    expect(await pruneDeadLetters()).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("deletes the OLDEST entries beyond the cap", async () => {
    vi.mocked(allEntries).mockResolvedValue(failedClaims(MAX_DEAD_LETTERS + 2));
    expect(await pruneDeadLetters()).toBe(2);
    expect(deleteEntry).toHaveBeenCalledWith("f0");
    expect(deleteEntry).toHaveBeenCalledWith("f1");
    expect(deleteEntry).not.toHaveBeenCalledWith(`f${MAX_DEAD_LETTERS + 1}`);
  });

  it("discards photo bytes for a pruned photo dead-letter (no orphaned PII)", async () => {
    vi.mocked(allEntries).mockResolvedValue([
      photoEntry({
        clientId: "f0",
        status: "failed",
        createdAt: 0,
        payload: { signId: 1, deployClientId: "gone-deploy" },
      }),
      ...failedClaims(MAX_DEAD_LETTERS).map((e, i) =>
        claimEntry({ clientId: `k${i}`, status: "failed", createdAt: i + 1 }),
      ),
    ]);
    expect(await pruneDeadLetters()).toBe(1);
    expect(deletePhoto).toHaveBeenCalledWith("gone-deploy");
    expect(deleteEntry).toHaveBeenCalledWith("f0");
  });

  it("never prunes PENDING entries", async () => {
    vi.mocked(allEntries).mockResolvedValue(
      Array.from({ length: MAX_DEAD_LETTERS + 5 }, (_, i) =>
        claimEntry({ clientId: `p${i}`, createdAt: i }),
      ),
    );
    expect(await pruneDeadLetters()).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("is best-effort — an IndexedDB fault must not break the mount", async () => {
    vi.mocked(allEntries).mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(pruneDeadLetters()).resolves.toBe(0);
  });
});

// Follow-ups from the fresh-context security review of this batch.
describe("drainOutbox — bounds found in review", () => {
  it("stops deferring a photo after MAX_PHOTO_DEFERRALS and discards the bytes", async () => {
    // An un-echoed deploy has nothing forcing it to resolve, so "wait for the
    // deploy" must not be an unbounded retention window for badge/face PII.
    vi.mocked(postDeploy).mockResolvedValue({ results: [] }); // never echoes
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      photoEntry({
        clientId: "p1",
        createdAt: 2,
        attempts: 10, // already deferred the maximum number of drains
        payload: { signId: 1, deployClientId: "d1" },
      }),
    ]);

    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(deletePhoto).toHaveBeenCalledWith("d1");
  });

  it("counts a deferral so the ceiling is actually approached", async () => {
    vi.mocked(postDeploy).mockResolvedValue({ results: [] });
    vi.mocked(postPhoto).mockRejectedValue(new ApiHttpError(404, "no event"));
    vi.mocked(allEntries).mockResolvedValue([
      deployEntry({ clientId: "d1", createdAt: 1 }),
      photoEntry({
        clientId: "p1",
        createdAt: 2,
        attempts: 0,
        payload: { signId: 1, deployClientId: "d1" },
      }),
    ]);

    await drainOutbox();
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "p1", attempts: 1, status: "pending" }),
    );
    expect(deletePhoto).not.toHaveBeenCalled();
  });

  it("survives a putEntry rejection while dead-lettering, keeping the drain result", async () => {
    // Symmetric with the /signs engine: an unguarded IDB write failure used to
    // propagate out and discard the whole DrainResult — including photoApplied
    // URLs whose bytes are already gone from IndexedDB. (#183/#245)
    vi.mocked(putEntry).mockRejectedValue(new Error("QuotaExceededError"));
    vi.mocked(postClaim)
      .mockRejectedValueOnce(new ApiHttpError(422, "bad"))
      .mockResolvedValueOnce({ granted: [2], rejected: [] });
    vi.mocked(allEntries).mockResolvedValue([
      claimEntry({ clientId: "c1", createdAt: 1 }),
      claimEntry({ clientId: "c2", createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    // Couldn't record the dead-letter, so it isn't counted — it stays pending.
    expect(res.deadLettered).toBe(0);
    // …and the drain carried on rather than throwing.
    expect(res.drained).toBe(1);
    expect(deleteEntry).toHaveBeenCalledWith("c2");
  });
});
