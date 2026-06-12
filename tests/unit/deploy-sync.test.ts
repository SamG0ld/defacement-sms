import { describe, it, expect, beforeEach, vi } from "vitest";

import { drainOutbox, syncOnce } from "@/app/(app)/deploy/_lib/sync";
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
    hasPhoto: false,
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
  vi.mocked(postPhoto).mockResolvedValue({ clientId: "d1", photoUrl: "/x" });
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
      return { clientId: "d1", photoUrl: "/x" };
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
      deployEntry({ clientId: "d2", createdAt: 2, payload: { signId: 2, crewId: 1, deployedAt: "2026-08-07T18:00:00.000Z", hasPhoto: false } }),
      deployEntry({ clientId: "d3", createdAt: 3, payload: { signId: 3, crewId: 1, deployedAt: "2026-08-07T18:00:00.000Z", hasPhoto: false } }),
    ]);

    const res = await drainOutbox();
    expect(postDeploy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postDeploy).mock.calls[0][0].events).toHaveLength(3);
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

  it("propagates a getChanges failure so the store can fall back to offline", async () => {
    vi.mocked(allEntries).mockResolvedValue([]);
    vi.mocked(getChanges).mockRejectedValue(new NetworkError("dropped"));
    await expect(syncOnce("cursor-1")).rejects.toBeInstanceOf(NetworkError);
  });
});
