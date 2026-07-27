import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  drainOutbox,
  NOT_FOUND_MESSAGE,
  pruneDeadLetters,
} from "@/app/(app)/signs/_sync/sync";
import { MAX_DEAD_LETTERS } from "@/lib/offline/dead-letter";
import {
  ApiHttpError,
  NetworkError,
  postSignStatus,
  postSignStatusBatch,
} from "@/app/(app)/signs/_sync/api";
import {
  allEntries,
  deleteEntry,
  putEntry,
} from "@/app/(app)/signs/_sync/idb";
import type { StatusOutboxEntry } from "@/app/(app)/signs/_sync/types";

// Keep the real NetworkError / ApiHttpError classes (the drain does
// `instanceof`), but replace the network calls with spies.
vi.mock("@/app/(app)/signs/_sync/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/(app)/signs/_sync/api")>();
  return { ...actual, postSignStatus: vi.fn(), postSignStatusBatch: vi.fn() };
});

// IndexedDB layer fully stubbed — drain logic is pure given these.
vi.mock("@/app/(app)/signs/_sync/idb", () => ({
  allEntries: vi.fn(),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
  putEntry: vi.fn().mockResolvedValue(undefined),
}));

const entry = (over: Partial<StatusOutboxEntry> = {}): StatusOutboxEntry => ({
  clientId: "c1",
  signId: 1,
  status: "deployed",
  changedAt: "2026-08-07T18:00:00.000Z",
  queueStatus: "pending",
  attempts: 0,
  createdAt: 100,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Echo every change back as applied; individual tests override.
  vi.mocked(postSignStatusBatch).mockImplementation(async (req) => ({
    results: req.changes.map((c) => ({
      clientId: c.clientId,
      signId: c.signId,
      status: c.status,
      result: "applied" as const,
    })),
  }));
  vi.mocked(postSignStatus).mockResolvedValue({
    signId: 1,
    status: "deployed",
    result: "applied",
  });
});

describe("drainOutbox — batched outcomes", () => {
  it("drains the whole queue with ONE batch POST", async () => {
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, createdAt: 2 }),
      entry({ clientId: "c3", signId: 3, createdAt: 3 }),
    ]);
    const res = await drainOutbox();
    expect(postSignStatusBatch).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(postSignStatusBatch).mock.calls[0][0].changes,
    ).toHaveLength(3);
    expect(postSignStatus).not.toHaveBeenCalled();
    expect(res.drained).toBe(3);
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(deleteEntry).toHaveBeenCalledWith("c3");
  });

  it.each(["duplicate", "noop"] as const)(
    "drops an entry on a %s result (nothing left to replay)",
    async (result) => {
      vi.mocked(postSignStatusBatch).mockResolvedValue({
        results: [{ clientId: "c1", signId: 1, status: "deployed", result }],
      });
      vi.mocked(allEntries).mockResolvedValue([entry()]);
      const res = await drainOutbox();
      expect(deleteEntry).toHaveBeenCalledWith("c1");
      expect(res.drained).toBe(1);
    },
  );

  it("dead-letters a not_found result with user feedback (does not drop)", async () => {
    vi.mocked(postSignStatusBatch).mockResolvedValue({
      results: [
        { clientId: "c1", signId: 1, status: "deployed", result: "not_found" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queueStatus: "failed",
        clientId: "c1",
        lastError: NOT_FOUND_MESSAGE,
      }),
    );
    expect(deleteEntry).not.toHaveBeenCalledWith("c1");
    expect(res.deadLettered).toBe(1);
    expect(res.drained).toBe(0);
  });

  it("leaves an entry pending when the server didn't echo its result", async () => {
    vi.mocked(postSignStatusBatch).mockResolvedValue({
      results: [
        { clientId: "c1", signId: 1, status: "deployed", result: "applied" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.drained).toBe(1);
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(deleteEntry).not.toHaveBeenCalledWith("c2");
  });

  it("NetworkError: stops the drain offline, leaves entries pending", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(new NetworkError("offline"));
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.authExpired).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(postSignStatusBatch).toHaveBeenCalledTimes(1);
  });

  it("401: flags authExpired and stops WITHOUT marking offline", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(
      new ApiHttpError(401, "expired"),
    );
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(res.authExpired).toBe(true);
    expect(res.stoppedOffline).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("batch 4xx: falls back to per-entry so only the offender dead-letters", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(new ApiHttpError(400, "bad"));
    vi.mocked(postSignStatus)
      .mockRejectedValueOnce(new ApiHttpError(400, "bad"))
      .mockResolvedValueOnce({ signId: 2, status: "sorted", result: "applied" });
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, status: "sorted", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ queueStatus: "failed", clientId: "c1" }),
    );
    // Did NOT break — the second entry still drained via the fallback.
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(res.drained).toBe(1);
  });

  it("401 inside the per-entry fallback: authExpired set, not offline, drain stops", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(new ApiHttpError(400, "bad"));
    vi.mocked(postSignStatus).mockRejectedValue(new ApiHttpError(401, "expired"));
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(res.authExpired).toBe(true);
    expect(res.stoppedOffline).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("429: transient stop (no dead-letter)", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(
      new ApiHttpError(429, "slow down"),
    );
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.deadLettered).toBe(0);
    expect(putEntry).not.toHaveBeenCalled();
  });

  it("skips already-failed (dead-lettered) entries", async () => {
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", queueStatus: "failed" }),
    ]);
    const res = await drainOutbox();
    expect(postSignStatusBatch).not.toHaveBeenCalled();
    expect(res.drained).toBe(0);
  });

  it("forbidden (batch): dead-letters with a reason instead of silently dropping (#99)", async () => {
    vi.mocked(postSignStatusBatch).mockResolvedValue({
      results: [
        { clientId: "c1", signId: 1, status: "deployed", result: "forbidden" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(res.forbidden).toBe(1);
    expect(res.drained).toBe(0);
    // Must NOT silently delete — the entry stays as a failed/discardable row.
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ queueStatus: "failed", clientId: "c1" }),
    );
  });

  it("forbidden (per-entry fallback): dead-letters that change, drains the rest (#99)", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(new ApiHttpError(400, "bad"));
    vi.mocked(postSignStatus)
      .mockResolvedValueOnce({ signId: 1, status: "deployed", result: "forbidden" })
      .mockResolvedValueOnce({ signId: 2, status: "sorted", result: "applied" });
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, status: "sorted", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.forbidden).toBe(1);
    expect(res.drained).toBe(1);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({ queueStatus: "failed", clientId: "c1" }),
    );
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(deleteEntry).not.toHaveBeenCalledWith("c1");
  });

  it("not_found (per-entry fallback): dead-letters that change, drains the rest", async () => {
    vi.mocked(postSignStatusBatch).mockRejectedValue(new ApiHttpError(400, "bad"));
    vi.mocked(postSignStatus)
      .mockResolvedValueOnce({ signId: 1, status: "deployed", result: "not_found" })
      .mockResolvedValueOnce({ signId: 2, status: "sorted", result: "applied" });
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, status: "sorted", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.deadLettered).toBe(1);
    expect(putEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queueStatus: "failed",
        clientId: "c1",
        lastError: NOT_FOUND_MESSAGE,
      }),
    );
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(deleteEntry).not.toHaveBeenCalledWith("c1");
  });
});

// drainOutbox performs IndexedDB writes (markFailed via putEntry, deleteEntry)
// inside its per-entry loop. Those CAN reject — quota exhausted, or iOS Safari
// closing the connection under a backgrounded tab. An unguarded rejection used to
// propagate out of drainOutbox and take the whole partial DrainResult with it, so
// entries the server had already accepted were never reflected: refreshOutbox was
// skipped, router.refresh never ran, and rows stayed badged "queued" for changes
// that had actually landed. (#245)
describe("drainOutbox — survives a mid-drain IndexedDB write failure (#245)", () => {
  it("does not throw when deleteEntry rejects, and still reports the drain", async () => {
    vi.mocked(deleteEntry)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException("closing", "InvalidStateError"))
      .mockResolvedValue(undefined);
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, createdAt: 2 }),
      entry({ clientId: "c3", signId: 3, createdAt: 3 }),
    ]);

    const res = await drainOutbox();
    // The first entry's delete stuck, the third still ran — one bad write cost
    // one entry, not the drain.
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(deleteEntry).toHaveBeenCalledWith("c3");
    // All three were accepted server-side, so the UI must reconcile to server
    // truth; the undeleted entry replays harmlessly (idempotent on clientId).
    expect(res.drained).toBe(3);
    expect(res.stoppedOffline).toBe(false);
  });

  it("does not throw when putEntry rejects while dead-lettering", async () => {
    vi.mocked(putEntry).mockRejectedValue(new Error("QuotaExceededError"));
    vi.mocked(postSignStatusBatch).mockResolvedValue({
      results: [
        { clientId: "c1", signId: 1, status: "deployed", result: "forbidden" },
        { clientId: "c2", signId: 2, status: "deployed", result: "applied" },
      ],
    });
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", signId: 2, createdAt: 2 }),
    ]);

    const res = await drainOutbox();
    // Couldn't record the dead-letter, so it is NOT counted as one — it stays
    // pending and the next drain retries.
    expect(res.forbidden).toBe(0);
    // …and the sibling entry still drained.
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(res.drained).toBe(1);
  });
});

// A dead-lettered entry sits in IndexedDB until the user discards it by hand, and
// nothing ever did — so a shared floor device accumulates them across a multi-day
// con, growing the store and the getAll+sort every tick does. (#207)
describe("pruneDeadLetters — bounds the dead-letter pile (#207)", () => {
  const failed = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({
        clientId: `f${i}`,
        queueStatus: "failed",
        createdAt: i, // oldest first
      }),
    );

  it("deletes nothing while at or under the cap", async () => {
    vi.mocked(allEntries).mockResolvedValue(failed(MAX_DEAD_LETTERS));
    expect(await pruneDeadLetters()).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("deletes the OLDEST entries beyond the cap, keeping the newest", async () => {
    vi.mocked(allEntries).mockResolvedValue(failed(MAX_DEAD_LETTERS + 3));
    expect(await pruneDeadLetters()).toBe(3);
    expect(deleteEntry).toHaveBeenCalledTimes(3);
    for (const id of ["f0", "f1", "f2"]) {
      expect(deleteEntry).toHaveBeenCalledWith(id);
    }
    // The most recent failure — the one someone is still acting on — survives.
    expect(deleteEntry).not.toHaveBeenCalledWith(`f${MAX_DEAD_LETTERS + 2}`);
  });

  it("never prunes PENDING entries — only dead-letters are capped", async () => {
    vi.mocked(allEntries).mockResolvedValue([
      ...failed(2),
      ...Array.from({ length: MAX_DEAD_LETTERS + 5 }, (_, i) =>
        entry({ clientId: `p${i}`, createdAt: 1000 + i }),
      ),
    ]);
    expect(await pruneDeadLetters()).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("is best-effort — an IndexedDB fault must not break the mount", async () => {
    vi.mocked(allEntries).mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(pruneDeadLetters()).resolves.toBe(0);
  });
});
