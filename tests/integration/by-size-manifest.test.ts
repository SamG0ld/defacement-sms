import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The manifest action/route run against REAL Prisma + the REAL matcher; only auth and
// the Figma network edge are mocked (figma-match stays real so flattenFigmaNodes +
// matchNodesToSigns actually parse the fake document tree).
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/figma-api", () => ({
  figmaToken: vi.fn(),
  fetchFileDocument: vi.fn(),
}));

import { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fetchFileDocument, figmaToken } from "@/lib/figma-api";
import { generateBucketManifest } from "@/app/(app)/signs/by-size/actions";
import { GET } from "@/app/(app)/signs/by-size/manifest/route";

const leadSession = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
};

const FIGMA_URL = "https://www.figma.com/design/abc123/DC34";

// A Figma document tree: the DOCUMENT root + a page container (both must be IGNORED),
// one active-sign instance, and one removed-sign instance still in the file.
function fakeDocument() {
  return {
    id: "0:0",
    name: "Document",
    children: [
      {
        id: "0:1",
        name: "Page 1",
        children: [
          { id: "1:1", name: "W100 - AEROSPACE VILLAGE" },
          { id: "1:2", name: "T-01 - TRAINING 01" },
        ],
      },
    ],
  };
}

async function seedBucket() {
  const batch = await prisma.generationBatch.create({
    data: {
      pipeline: "figma-mcp",
      signCount: 2,
      createdById: "u1",
      figmaUrl: FIGMA_URL,
    },
    select: { id: true },
  });
  const active = await prisma.sign.create({
    data: {
      itemId: "W100",
      signText: "Aerospace Village",
      signType: '22"x28"',
      size: "22x28",
      status: "generated" as never,
      generationBatchId: batch.id,
    },
  });
  const removed = await prisma.sign.create({
    data: {
      itemId: "T-01",
      signText: "Training 01",
      signType: '22"x28"',
      size: "22x28",
      status: "archived" as never,
      generationBatchId: batch.id,
    },
  });
  return { batchId: batch.id, active, removed };
}

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(leadSession as never);
  vi.mocked(figmaToken).mockReturnValue("tok");
  vi.mocked(fetchFileDocument).mockResolvedValue(fakeDocument());
});
afterEach(() => vi.clearAllMocks());

describe("generateBucketManifest", () => {
  it("reconciles the bucket's file: active sign in-file, removed sign's node flagged delete, containers ignored", async () => {
    await seedBucket();

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const m = result.manifest;
    expect(m.counts.inFile).toBe(1);
    expect(m.counts.deletes).toBe(1); // ONLY the removed sign — not Document/Page 1
    expect(m.counts.appends).toBe(0);
    expect(m.counts.ambiguous).toBe(0);
    expect(m.files).toHaveLength(1);
    expect(m.files[0].fileKey).toBe("abc123");
    expect(m.files[0].deletes[0].nodeName).toContain("T-01");
  });

  it("counts a file once when two batches point at the same file URL", async () => {
    // Canonicalize-on-save means two batches on one file store an IDENTICAL string,
    // so the bucket reconciles that file once — one file entry, its removed node
    // deleted once, inFile counted once (not doubled per batch).
    await seedBucket(); // batch 1 → FIGMA_URL (active W100 + removed T-01)
    const batch2 = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 1,
        createdById: "u1",
        figmaUrl: FIGMA_URL, // same canonical file URL as batch 1
      },
      select: { id: true },
    });
    await prisma.sign.create({
      data: {
        itemId: "W300",
        signText: "Car Hacking Village",
        signType: '22"x28"',
        size: "22x28",
        status: "generated" as never,
        generationBatchId: batch2.id,
      },
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.counts.files).toBe(1); // ONE file entry despite two batches
    expect(m.files).toHaveLength(1);
    expect(m.counts.inFile).toBe(1); // W100 matched once, not once-per-batch
    expect(m.counts.deletes).toBe(1); // T-01's node flagged once
  });

  it("flags an active sign missing from the file as an append", async () => {
    const { batchId } = await seedBucket();
    // A second active sign with no matching node in the file.
    await prisma.sign.create({
      data: {
        itemId: "W200",
        signText: "Car Hacking Village",
        signType: '22"x28"',
        size: "22x28",
        status: "generated" as never,
        generationBatchId: batchId,
      },
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.counts.appends).toBe(1);
    expect(result.manifest.appends[0].itemId).toBe("W200");
  });

  it("surfaces a stale unmatched instance (no active/removed sign) as an orphan", async () => {
    await seedBucket();
    // The active W100 instance + a stale INSTANCE that ties to no active or removed sign.
    vi.mocked(fetchFileDocument).mockResolvedValue({
      id: "0:0",
      name: "Document",
      children: [
        { id: "1:1", name: "W100 - AEROSPACE VILLAGE", type: "INSTANCE" },
        { id: "1:9", name: "W900 - OLD DELETED SIGN", type: "INSTANCE" },
      ],
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.counts.inFile).toBe(1);
    expect(result.manifest.counts.orphans).toBe(1);
    expect(result.manifest.files[0].orphanNodes[0].nodeName).toContain("W900");
  });

  it("recognizes a text edit via the stored node id as a correction (no append, no orphan)", async () => {
    // A rendered sign whose text was edited: its stored figmaInstanceNodeId still points at the
    // file's node, now under the OLD name → retext in place, not a duplicate append.
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 1,
        createdById: "u1",
        figmaUrl: FIGMA_URL,
      },
      select: { id: true },
    });
    await prisma.sign.create({
      data: {
        itemId: "W326",
        signText: "VETCON 2026 Party",
        signType: '22"x28"',
        size: "22x28",
        status: "generated" as never,
        generationBatchId: batch.id,
        figmaInstanceNodeId: "1:9",
      },
    });
    vi.mocked(fetchFileDocument).mockResolvedValue({
      id: "0:0",
      name: "Document",
      children: [{ id: "1:9", name: "W326 - VETCON 2025 PARTY", type: "INSTANCE" }],
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.counts.corrections).toBe(1);
    expect(result.manifest.counts.appends).toBe(0);
    expect(result.manifest.counts.orphans).toBe(0);
    expect(result.manifest.files[0].corrections[0]).toMatchObject({
      nodeId: "1:9",
      toName: "W326 - VETCON 2026 PARTY",
    });
  });

  it("a node claimed by both an active and a removed sign is ambiguous — and NOT also an append", async () => {
    // Same booth + text as both an active and an archived sign → one node can't be tied to
    // one sign. The active sign must surface as ambiguous, never double-listed as an append.
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 2,
        createdById: "u1",
        figmaUrl: FIGMA_URL,
      },
      select: { id: true },
    });
    await prisma.sign.create({
      data: {
        itemId: "W100",
        signText: "Aerospace Village",
        signType: '22"x28"',
        size: "22x28",
        status: "generated" as never,
        generationBatchId: batch.id,
      },
    });
    await prisma.sign.create({
      data: {
        itemId: "W100",
        signText: "Aerospace Village",
        signType: '22"x28"',
        size: "22x28",
        status: "archived" as never,
        generationBatchId: batch.id,
      },
    });
    // Only the one "W100 - AEROSPACE VILLAGE" node exists (drop the T-01 node for clarity).
    vi.mocked(fetchFileDocument).mockResolvedValue({
      id: "0:0",
      name: "Document",
      children: [{ id: "1:1", name: "W100 - AEROSPACE VILLAGE" }],
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.counts.ambiguous).toBeGreaterThanOrEqual(1);
    expect(result.manifest.counts.deletes).toBe(0); // never blind-delete a maybe-live node
    expect(result.manifest.counts.appends).toBe(0); // the active sign is ambiguous, not an append
    expect(result.manifest.appends).toHaveLength(0);
  });

  it("excludes isTestData signs — a test sign is never listed for render into the production file", async () => {
    const { batchId } = await seedBucket();
    // A sign from an "Import as test data" run (the ImportWizard's default) with no node
    // in the file. Unfiltered it surfaced as an append — i.e. an instruction to render a
    // throwaway test sign into the real Figma file (#224).
    await prisma.sign.create({
      data: {
        itemId: "TD-01",
        signText: "Import Smoke Test",
        signType: '22"x28"',
        size: "22x28",
        status: "generated" as never,
        isTestData: true,
        generationBatchId: batchId,
      },
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.appends).toHaveLength(0);
    expect(result.manifest.counts.appends).toBe(0);
    expect(result.manifest.counts.activeSigns).toBe(1); // W100 only — TD-01 is out
  });

  it("never flags a delete for an ARCHIVED isTestData sign — its node degrades to a reviewable orphan", async () => {
    const { batchId } = await seedBucket();
    await prisma.sign.create({
      data: {
        itemId: "TD-02",
        signText: "Removed Test Sign",
        signType: '22"x28"',
        size: "22x28",
        status: "archived" as never,
        isTestData: true,
        generationBatchId: batchId,
      },
    });
    // W100's live node + a node named for the archived TEST sign. T-01's node is dropped
    // so the only delete candidate on offer is the test one.
    vi.mocked(fetchFileDocument).mockResolvedValue({
      id: "0:0",
      name: "Document",
      children: [
        { id: "1:1", name: "W100 - AEROSPACE VILLAGE", type: "INSTANCE" },
        { id: "1:3", name: "TD-02 - REMOVED TEST SIGN", type: "INSTANCE" },
      ],
    });

    const result = await generateBucketManifest("foamcore-22x28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Excluding test data must not hand the follow-on pass a delete anchored to a row it
    // can no longer see — and must not silently drop the node either: it becomes an orphan
    // ("delete?"), which a human decides on.
    expect(result.manifest.counts.deletes).toBe(0);
    expect(result.manifest.counts.orphans).toBe(1);
    expect(result.manifest.files[0].orphanNodes[0].nodeName).toContain("TD-02");
  });

  it("errors when the size has no linked Figma file", async () => {
    // A bucket whose signs' batch has no figmaUrl.
    const batch = await prisma.generationBatch.create({
      data: { pipeline: "figma-mcp", signCount: 1, createdById: "u1" },
      select: { id: true },
    });
    await prisma.sign.create({
      data: {
        itemId: "MB1",
        signText: "Meterboard",
        signType: "Meterboard (4'x8')",
        size: "4'x8' Single",
        status: "generated" as never,
        generationBatchId: batch.id,
      },
    });

    const result = await generateBucketManifest("meterboard-single");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Figma file linked");
  });

  it("rejects an unknown bucket key", async () => {
    const result = await generateBucketManifest("not-a-bucket");
    expect(result.ok).toBe(false);
  });

  it("refuses a volunteer (lead+ only)", async () => {
    await seedBucket();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "v@example.com", isActive: true, role: "volunteer" },
    } as never);
    await expect(generateBucketManifest("foamcore-22x28")).rejects.toThrow();
  });
});

describe("GET /signs/by-size/manifest", () => {
  function get(bucket: string) {
    return GET(
      new NextRequest(
        `http://localhost/signs/by-size/manifest?bucket=${encodeURIComponent(bucket)}`,
      ),
    );
  }

  it("streams the manifest JSON with an attachment filename", async () => {
    await seedBucket();
    const res = await get("foamcore-22x28");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(
      "figma-manifest-foamcore-22x28-",
    );
    const body = JSON.parse(await res.text());
    expect(body.bucketKey).toBe("foamcore-22x28");
    expect(body.counts.deletes).toBe(1);
  });

  it("403s a volunteer", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "v@example.com", isActive: true, role: "volunteer" },
    } as never);
    const res = await get("foamcore-22x28");
    expect(res.status).toBe(403);
  });

  it("400s an unknown bucket", async () => {
    const res = await get("not-a-bucket");
    expect(res.status).toBe(400);
  });
});
