import { describe, it, expect, beforeEach, vi } from "vitest";

import { drainOutbox } from "@/app/(app)/signs/_sync/sync";
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

  it.each(["duplicate", "noop", "not_found"] as const)(
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
});
