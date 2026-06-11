import { describe, it, expect, beforeEach, vi } from "vitest";

import { drainOutbox } from "@/app/(app)/signs/_sync/sync";
import {
  ApiHttpError,
  NetworkError,
  postSignStatus,
} from "@/app/(app)/signs/_sync/api";
import {
  allEntries,
  deleteEntry,
  putEntry,
} from "@/app/(app)/signs/_sync/idb";
import type { StatusOutboxEntry } from "@/app/(app)/signs/_sync/types";

// Keep the real NetworkError / ApiHttpError classes (processEntry does
// `instanceof`), but replace the network call with a spy.
vi.mock("@/app/(app)/signs/_sync/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/(app)/signs/_sync/api")>();
  return { ...actual, postSignStatus: vi.fn() };
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
  vi.mocked(postSignStatus).mockResolvedValue({
    signId: 1,
    status: "deployed",
    result: "applied",
  });
});

describe("drainOutbox — outcomes", () => {
  it("ok: a 2xx result deletes the entry and counts it drained", async () => {
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(deleteEntry).toHaveBeenCalledWith("c1");
    expect(res.drained).toBe(1);
    expect(res.stoppedOffline).toBe(false);
  });

  it.each(["duplicate", "noop", "not_found"] as const)(
    "drops the entry on a %s result (nothing left to replay)",
    async (result) => {
      vi.mocked(postSignStatus).mockResolvedValue({
        signId: 1,
        status: "deployed",
        result,
      });
      vi.mocked(allEntries).mockResolvedValue([entry()]);
      const res = await drainOutbox();
      expect(deleteEntry).toHaveBeenCalledWith("c1");
      expect(res.drained).toBe(1);
    },
  );

  it("NetworkError: stops the drain offline, leaves the entry pending", async () => {
    vi.mocked(postSignStatus).mockRejectedValue(new NetworkError("offline"));
    vi.mocked(allEntries).mockResolvedValue([
      entry({ clientId: "c1", createdAt: 1 }),
      entry({ clientId: "c2", createdAt: 2 }),
    ]);
    const res = await drainOutbox();
    expect(res.stoppedOffline).toBe(true);
    expect(res.authExpired).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
    // Broke after the first failure — never tried the second entry.
    expect(postSignStatus).toHaveBeenCalledTimes(1);
  });

  it("401: flags authExpired and stops WITHOUT marking offline", async () => {
    vi.mocked(postSignStatus).mockRejectedValue(new ApiHttpError(401, "expired"));
    vi.mocked(allEntries).mockResolvedValue([entry()]);
    const res = await drainOutbox();
    expect(res.authExpired).toBe(true);
    expect(res.stoppedOffline).toBe(false);
    expect(res.drained).toBe(0);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("permanent 4xx (400): dead-letters and continues with the rest", async () => {
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
    // Did NOT break — the second entry still drained.
    expect(deleteEntry).toHaveBeenCalledWith("c2");
    expect(res.drained).toBe(1);
  });

  it("429: transient stop (no dead-letter)", async () => {
    vi.mocked(postSignStatus).mockRejectedValue(new ApiHttpError(429, "slow down"));
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
    expect(postSignStatus).not.toHaveBeenCalled();
    expect(res.drained).toBe(0);
  });
});
