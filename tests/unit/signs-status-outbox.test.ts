import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { enqueueStatus } from "@/app/(app)/signs/_sync/outbox";
import { allEntries } from "@/app/(app)/signs/_sync/idb";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  // Fresh DB per test so allEntries() sees only this test's writes.
  globalThis.indexedDB = new IDBFactory();
});

describe("enqueueStatus — durable status-change entry shape", () => {
  it("persists a pending entry with a UUID clientId and an ISO changedAt", async () => {
    const entry = await enqueueStatus(42, "deployed", "north hall");
    expect(entry).toMatchObject({
      signId: 42,
      status: "deployed",
      notes: "north hall",
      queueStatus: "pending",
      attempts: 0,
    });
    expect(entry.clientId).toMatch(UUID_V4);
    expect(new Date(entry.changedAt).toISOString()).toBe(entry.changedAt);

    const all = await allEntries();
    expect(all).toHaveLength(1);
    expect(all[0].clientId).toBe(entry.clientId);
  });

  it("omits empty/whitespace notes rather than storing a blank string", async () => {
    const blank = await enqueueStatus(1, "printed", "   ");
    expect(blank.notes).toBeUndefined();
    const none = await enqueueStatus(2, "printed");
    expect(none.notes).toBeUndefined();
  });

  it("each enqueue gets a distinct idempotency key", async () => {
    const a = await enqueueStatus(1, "sorted");
    const b = await enqueueStatus(1, "sorted");
    expect(a.clientId).not.toBe(b.clientId);
    const all = await allEntries();
    expect(all).toHaveLength(2);
  });
});

describe("newClientId — UUID v4 fallback when crypto.randomUUID is absent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a valid v4 UUID via getRandomValues on insecure-context browsers", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: real.getRandomValues.bind(real),
    });
    const entry = await enqueueStatus(1, "sorted");
    expect(entry.clientId).toMatch(UUID_V4);
  });
});
