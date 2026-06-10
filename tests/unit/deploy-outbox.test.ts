import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  enqueueClaim,
  enqueueRelease,
  enqueueDeploy,
} from "@/app/(app)/deploy/_lib/outbox";
import { allEntries, getPhoto } from "@/app/(app)/deploy/_lib/idb";
import type {
  ClaimPayload,
  DeployPayload,
  PhotoPayload,
  ReleasePayload,
} from "@/app/(app)/deploy/_lib/types";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  // Fresh DB per test so allEntries() sees only this test's writes.
  globalThis.indexedDB = new IDBFactory();
});

describe("enqueueClaim / enqueueRelease — durable outbox entry shape", () => {
  it("persists a pending claim entry with the right payload", async () => {
    const entry = await enqueueClaim(7, [1, 2, 3]);
    expect(entry).toMatchObject({
      kind: "claim",
      status: "pending",
      attempts: 0,
      payload: { crewId: 7, signIds: [1, 2, 3] } satisfies ClaimPayload,
    });
    expect(entry.clientId).toMatch(UUID_V4);

    const all = await allEntries();
    expect(all).toHaveLength(1);
    expect(all[0].clientId).toBe(entry.clientId);
  });

  it("persists a pending release entry", async () => {
    const entry = await enqueueRelease(7, [9]);
    expect(entry).toMatchObject({
      kind: "release",
      status: "pending",
      payload: { crewId: 7, signIds: [9] } satisfies ReleasePayload,
    });
  });
});

describe("enqueueDeploy — deploy + optional photo", () => {
  it("writes a single deploy entry when there's no photo", async () => {
    await enqueueDeploy({ signId: 5, crewId: 7, notes: "north hall" });
    const all = await allEntries();
    expect(all).toHaveLength(1);
    const p = all[0].payload as DeployPayload;
    expect(all[0].kind).toBe("deploy");
    expect(p.signId).toBe(5);
    expect(p.hasPhoto).toBe(false);
    expect(p.notes).toBe("north hall");
  });

  it("writes deploy + photo entries sharing the deploy clientId, photo sorts after", async () => {
    const blob = new Blob(["fake-bytes"], { type: "image/png" });
    const deploy = await enqueueDeploy({ signId: 5, crewId: 7 }, blob);

    const all = await allEntries(); // sorted by createdAt asc
    expect(all).toHaveLength(2);

    const deployEntry = all.find((e) => e.kind === "deploy")!;
    const photoEntry = all.find((e) => e.kind === "photo")!;
    expect(deployEntry.clientId).toBe(deploy.clientId);
    expect((deployEntry.payload as DeployPayload).hasPhoto).toBe(true);

    // Photo bytes are stashed under the DEPLOY's clientId so the upload finds them.
    const photoPayload = photoEntry.payload as PhotoPayload;
    expect(photoPayload.deployClientId).toBe(deploy.clientId);
    expect(await getPhoto(deploy.clientId)).toBeInstanceOf(Blob);

    // Photo's createdAt is bumped a tick so it always drains after its deploy.
    expect(photoEntry.createdAt).toBe(deployEntry.createdAt + 1);
    expect(all[0].kind).toBe("deploy");
    expect(all[1].kind).toBe("photo");
  });
});

describe("newClientId — UUID v4 fallback when crypto.randomUUID is absent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a valid v4 UUID via getRandomValues on insecure-context browsers", async () => {
    // Simulate plain-HTTP/LAN where randomUUID is undefined but getRandomValues
    // exists — enqueue must still produce a well-formed idempotency key.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: real.getRandomValues.bind(real),
    });
    const entry = await enqueueClaim(1, [1]);
    expect(entry.clientId).toMatch(UUID_V4);
  });
});
