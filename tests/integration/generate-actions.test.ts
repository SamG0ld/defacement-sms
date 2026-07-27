import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server Actions use redirect()/revalidatePath() as their terminal signal and
// auth() for authorization — request-context APIs unavailable in a node test, so
// we mock them. Prisma is REAL (the point of these tests).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT");
    (e as unknown as { redirectUrl: string }).redirectUrl = url;
    throw e;
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOTFOUND");
  }),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
// importBatchPreviews (#70/#106) fans out to the Figma client + blob layer; mock the
// network/storage edges so the action runs against REAL Prisma but no real I/O.
vi.mock("@/lib/figma-api", () => ({
  figmaToken: vi.fn(),
  fetchFileDocument: vi.fn(),
  fetchNodeImages: vi.fn(),
  fetchRenderedImage: vi.fn(),
}));
vi.mock("@/lib/figma-match", () => ({
  flattenFigmaNodes: vi.fn(),
  matchNodesToSigns: vi.fn(),
}));
vi.mock("@/lib/image-upload", () => ({ validateImageUpload: vi.fn() }));
vi.mock("@/lib/blob-image", () => ({
  putPrivateImage: vi.fn(),
  deletePrivateImage: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatForKey } from "@/lib/sign-format";
import {
  deleteGenerationBatch,
  generateSelection,
  importBatchPreviewsSlice,
  updateBatchFigmaUrl,
} from "@/app/(app)/signs/generate-actions";
import {
  figmaToken,
  fetchFileDocument,
  fetchNodeImages,
  fetchRenderedImage,
} from "@/lib/figma-api";
import { flattenFigmaNodes, matchNodesToSigns } from "@/lib/figma-match";
import { validateImageUpload } from "@/lib/image-upload";
import { putPrivateImage, deletePrivateImage } from "@/lib/blob-image";

const leadSession = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(leadSession as never);
});
afterEach(() => vi.clearAllMocks());

async function captureRedirect(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { redirectUrl?: string }).redirectUrl;
    if (url !== undefined) return url;
    throw e;
  }
  throw new Error("expected a redirect, but none was thrown");
}

function idsForm(ids: number[]): FormData {
  const fd = new FormData();
  fd.set("ids", JSON.stringify(ids));
  fd.set("returnTo", "/signs");
  return fd;
}

function seedSign(over: Record<string, unknown> = {}) {
  return prisma.sign.create({
    data: {
      itemId: "SEED",
      signText: "Seed",
      signType: "22x28",
      size: "22x28",
      ...over,
    },
  });
}

describe("generateSelection", () => {
  it("creates a batch, links the signs, flips them to generated, records history + audit", async () => {
    // Both seed signs default to size 22x28 → one format bucket → one batch.
    const a = await seedSign({ itemId: "G1" });
    const b = await seedSign({ itemId: "G2", status: "printed" });

    const url = await captureRedirect(generateSelection(idsForm([a.id, b.id])));
    // Split-by-size now always lands on the /signs/generate index (N batches),
    // never a per-batch URL.
    expect(url).toBe("/signs/generate");

    const signs = await prisma.sign.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { status: true, generationBatchId: true, generationPipeline: true },
    });
    const batchId = signs[0].generationBatchId!;
    expect(signs.every((s) => s.generationBatchId === batchId)).toBe(true);

    const batch = await prisma.generationBatch.findUnique({
      where: { id: batchId },
      include: { signs: { select: { id: true } } },
    });
    expect(batch).not.toBeNull();
    expect(batch!.signCount).toBe(2);
    // Batch is auto-labeled by its format.
    expect(batch!.label).toBe(formatForKey("foamcore-22x28")!.label);
    expect(batch!.pipeline).toBe("figma-mcp");
    expect(batch!.createdById).toBe("u1");
    expect(new Set(batch!.signs.map((s) => s.id))).toEqual(new Set([a.id, b.id]));

    expect(signs.every((s) => s.status === "generated")).toBe(true);
    expect(signs.every((s) => s.generationPipeline === "figma-mcp")).toBe(true);

    const hist = await prisma.statusHistory.findMany({
      where: { signId: { in: [a.id, b.id] } },
    });
    expect(hist).toHaveLength(2);
    expect(hist.every((h) => h.newStatus === "generated")).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { action: "sign.generate" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain("across 1 batch by size");
    expect(audit[0].detail).toContain(`#${batchId}`);
  });

  // #172: this is the worst of the archived-exclusion gaps — Generate flips
  // status AND links a batch, so an archived sign caught in the selection would
  // be silently resurrected into the print pipeline with no `restored` trace.
  it("refuses to resurrect an archived sign", async () => {
    const live = await seedSign({ itemId: "AG-L" });
    const gone = await seedSign({ itemId: "AG-A", status: "archived" });

    await captureRedirect(generateSelection(idsForm([live.id, gone.id])));

    const after = await prisma.sign.findUnique({ where: { id: gone.id } });
    expect(after?.status).toBe("archived");
    expect(after?.generationBatchId).toBeNull();
    expect(await prisma.statusHistory.count({ where: { signId: gone.id } })).toBe(0);
    // The live sign in the same selection still generated, and the batch counts
    // only it — the guard narrows the set, it doesn't reject the call.
    const live2 = await prisma.sign.findUnique({ where: { id: live.id } });
    expect(live2?.status).toBe("generated");
    const batch = await prisma.generationBatch.findUniqueOrThrow({
      where: { id: live2!.generationBatchId! },
    });
    expect(batch.signCount).toBe(1);
  });

  it("errors when the whole selection is archived", async () => {
    const gone = await seedSign({ itemId: "AG-ONLY", status: "archived" });
    const url = await captureRedirect(generateSelection(idsForm([gone.id])));
    expect(url).toContain("error=");
    expect(await prisma.generationBatch.count()).toBe(0);
  });

  it("splits a mixed-size selection into one batch per format", async () => {
    const a = await seedSign({ itemId: "MS1", size: "22x28" });
    const b = await seedSign({
      itemId: "MS2",
      size: "4'x8' Single",
      signType: "Meterboard (4'x8')",
    });

    const url = await captureRedirect(generateSelection(idsForm([a.id, b.id])));
    expect(url).toBe("/signs/generate");

    const batches = await prisma.generationBatch.findMany({
      include: { signs: { select: { id: true } } },
    });
    expect(batches).toHaveLength(2);

    const byLabel = new Map(batches.map((x) => [x.label, x]));
    const easel = byLabel.get(formatForKey("foamcore-22x28")!.label);
    const meter = byLabel.get(formatForKey("meterboard-single")!.label);
    expect(easel?.signCount).toBe(1);
    expect(meter?.signCount).toBe(1);
    // Each sign is linked to its own format's batch.
    expect(easel!.signs.map((s) => s.id)).toEqual([a.id]);
    expect(meter!.signs.map((s) => s.id)).toEqual([b.id]);

    const audit = await prisma.auditLog.findMany({ where: { action: "sign.generate" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain("across 2 batches by size");
  });

  it("does not record history for a sign already generated, but still links it", async () => {
    const already = await seedSign({ itemId: "G3", status: "generated" });

    await captureRedirect(generateSelection(idsForm([already.id])));

    const hist = await prisma.statusHistory.findMany({ where: { signId: already.id } });
    expect(hist).toHaveLength(0); // no no-op transition recorded
    const after = await prisma.sign.findUnique({ where: { id: already.id } });
    expect(after?.generationBatchId).not.toBeNull(); // but it's in the batch
  });

  it("rejects an empty selection", async () => {
    const fd = new FormData();
    fd.set("ids", JSON.stringify([]));
    fd.set("returnTo", "/signs");
    const url = await captureRedirect(generateSelection(fd));
    expect(url).toContain("error=");
    expect(await prisma.generationBatch.count()).toBe(0);
  });

  it("refuses a volunteer (lead+ only)", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "vol@example.com", isActive: true, role: "volunteer" },
    } as never);
    const s = await seedSign({ itemId: "G4" });
    await expect(generateSelection(idsForm([s.id]))).rejects.toThrow();
    expect(await prisma.generationBatch.count()).toBe(0);
  });
});

describe("updateBatchFigmaUrl", () => {
  async function makeBatch() {
    return prisma.generationBatch.create({
      data: { pipeline: "figma-mcp", signCount: 0, createdById: "u1" },
      select: { id: true },
    });
  }

  it("stores a valid figma URL canonicalized (drops the title slug)", async () => {
    const { id } = await makeBatch();
    const fd = new FormData();
    fd.set("figmaUrl", "https://www.figma.com/design/abc/DC34");
    const url = await captureRedirect(updateBatchFigmaUrl(id, fd));
    expect(url).toBe(`/signs/generate/${id}`);
    const after = await prisma.generationBatch.findUnique({ where: { id } });
    expect(after?.figmaUrl).toBe("https://www.figma.com/design/abc");
  });

  it("canonicalizes away the ?t= share token on save", async () => {
    const { id } = await makeBatch();
    const fd = new FormData();
    fd.set("figmaUrl", "https://www.figma.com/design/abc/4x8-Double?t=jHvdoqM-0");
    await captureRedirect(updateBatchFigmaUrl(id, fd));
    const after = await prisma.generationBatch.findUnique({ where: { id } });
    expect(after?.figmaUrl).toBe("https://www.figma.com/design/abc");
  });

  it("stores the same file linked two different ways as one identical string", async () => {
    const a = await makeBatch();
    const b = await makeBatch();
    const fdA = new FormData();
    fdA.set("figmaUrl", "https://www.figma.com/design/abc/4x8-Double?t=aaa");
    await captureRedirect(updateBatchFigmaUrl(a.id, fdA));
    const fdB = new FormData();
    fdB.set("figmaUrl", "https://figma.com/design/abc/Other-Slug?node-id=9-9");
    await captureRedirect(updateBatchFigmaUrl(b.id, fdB));
    const afterA = await prisma.generationBatch.findUnique({ where: { id: a.id } });
    const afterB = await prisma.generationBatch.findUnique({ where: { id: b.id } });
    expect(afterA?.figmaUrl).toBe("https://www.figma.com/design/abc");
    expect(afterB?.figmaUrl).toBe(afterA?.figmaUrl);
  });

  it("rejects a non-figma / unsafe URL without storing it", async () => {
    const { id } = await makeBatch();
    const fd = new FormData();
    fd.set("figmaUrl", "javascript:alert(1)");
    const url = await captureRedirect(updateBatchFigmaUrl(id, fd));
    expect(url).toContain("error=");
    const after = await prisma.generationBatch.findUnique({ where: { id } });
    expect(after?.figmaUrl).toBeNull();
  });

  it("clears the link on an empty value", async () => {
    const b = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 0,
        createdById: "u1",
        figmaUrl: "https://figma.com/file/x",
      },
      select: { id: true },
    });
    const fd = new FormData();
    fd.set("figmaUrl", "");
    await captureRedirect(updateBatchFigmaUrl(b.id, fd));
    const after = await prisma.generationBatch.findUnique({ where: { id: b.id } });
    expect(after?.figmaUrl).toBeNull();
  });
});

describe("deleteGenerationBatch", () => {
  async function makeBatchWithSigns(itemIds: string[]) {
    const signs = await Promise.all(itemIds.map((itemId) => seedSign({ itemId })));
    const batch = await prisma.generationBatch.create({
      data: {
        label: "Test batch",
        pipeline: "figma-mcp",
        signCount: signs.length,
        createdById: "u1",
        signs: { connect: signs.map((s) => ({ id: s.id })) },
      },
      select: { id: true },
    });
    return { batchId: batch.id, signIds: signs.map((s) => s.id) };
  }

  it("deletes the batch, preserves the signs (unlinked), and audits", async () => {
    const { batchId, signIds } = await makeBatchWithSigns(["D1", "D2"]);

    const url = await captureRedirect(
      deleteGenerationBatch(batchId),
    );
    expect(url).toBe("/signs/generate");

    // Batch row is gone.
    expect(
      await prisma.generationBatch.findUnique({ where: { id: batchId } }),
    ).toBeNull();

    // Signs survive, only unlinked (onDelete: SetNull).
    const signs = await prisma.sign.findMany({
      where: { id: { in: signIds } },
      select: { id: true, generationBatchId: true },
    });
    expect(signs).toHaveLength(2);
    expect(signs.every((s) => s.generationBatchId === null)).toBe(true);

    const audit = await prisma.auditLog.findMany({
      where: { action: "batch.delete" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain(`#${batchId}`);
    expect(audit[0].detail).toContain("2 signs unlinked");
  });

  it("redirects with a friendly error for a non-existent batch (no throw)", async () => {
    const url = await captureRedirect(
      deleteGenerationBatch(999999),
    );
    expect(url).toContain("error=");
    expect(
      await prisma.auditLog.count({ where: { action: "batch.delete" } }),
    ).toBe(0);
  });

  it("refuses a volunteer (lead+ only) and leaves the batch intact", async () => {
    const { batchId } = await makeBatchWithSigns(["D3"]);
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "vol@example.com", isActive: true, role: "volunteer" },
    } as never);

    await expect(
      deleteGenerationBatch(batchId),
    ).rejects.toThrow();
    expect(
      await prisma.generationBatch.findUnique({ where: { id: batchId } }),
    ).not.toBeNull();
  });
});

describe("importBatchPreviewsSlice — blob cleanup (#106) + per-sign failures (#70) + slicing", () => {
  async function seedBatchWithSign(itemId: string) {
    const sign = await seedSign({ itemId });
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 1,
        createdById: "u1",
        figmaUrl: "https://www.figma.com/design/abc123/DC34",
        signs: { connect: { id: sign.id } },
      },
      select: { id: true },
    });
    return { sign, batchId: batch.id };
  }

  // Wire the mocked Figma client + validator so one sign matches and renders.
  function happyFigmaPath(sign: { id: number }, itemId: string) {
    vi.mocked(figmaToken).mockReturnValue("tok");
    vi.mocked(fetchFileDocument).mockResolvedValue({});
    vi.mocked(flattenFigmaNodes).mockReturnValue([]);
    vi.mocked(matchNodesToSigns).mockReturnValue({
      matched: [{ signId: sign.id, itemId, nodeId: "1:2" }],
      unmatchedSigns: [],
    } as never);
    vi.mocked(fetchNodeImages).mockResolvedValue({ "1:2": "https://figma/img" });
    vi.mocked(fetchRenderedImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(validateImageUpload).mockReturnValue({
      ok: true,
      image: { contentType: "image/png" },
    } as never);
  }

  // Mock the whole Figma path for an arbitrary set of matched signs, rendering a url
  // for every requested node (so any slice's nodes resolve).
  function mockMatched(
    signs: { id: number }[],
    itemIds: string[],
    unmatched: { id: number; itemId: string }[] = [],
  ) {
    vi.mocked(figmaToken).mockReturnValue("tok");
    vi.mocked(fetchFileDocument).mockResolvedValue({});
    vi.mocked(flattenFigmaNodes).mockReturnValue([]);
    vi.mocked(matchNodesToSigns).mockReturnValue({
      matched: signs.map((s, i) => ({
        signId: s.id,
        itemId: itemIds[i],
        nodeId: `n${s.id}`,
        width: 3300,
        height: 4200,
      })),
      unmatchedSigns: unmatched,
    } as never);
    vi.mocked(fetchNodeImages).mockImplementation(
      async (_key, ns: { id: string }[]) =>
        Object.fromEntries(ns.map((n) => [n.id, `https://figma/img/${n.id}`])),
    );
    vi.mocked(fetchRenderedImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(validateImageUpload).mockReturnValue({
      ok: true,
      image: { contentType: "image/png" },
    } as never);
    vi.mocked(putPrivateImage).mockImplementation(
      async (_dir: string, id: string) => `sign-previews/${id}.png`,
    );
  }

  it("deletes the uploaded blob and counts the sign failed when the DB write throws", async () => {
    const { sign, batchId } = await seedBatchWithSign("IMP1");
    happyFigmaPath(sign, "IMP1");
    vi.mocked(putPrivateImage).mockResolvedValue("sign-previews/IMP1-xyz.png");
    const updateSpy = vi
      .spyOn(prisma.sign, "update")
      .mockRejectedValueOnce(new Error("db down"));

    try {
      const result = await importBatchPreviewsSlice(batchId, 0);

      expect(deletePrivateImage).toHaveBeenCalledWith("sign-previews/IMP1-xyz.png");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.imported).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.done).toBe(true);
      }
    } finally {
      updateSpy.mockRestore(); // restore even if an assertion above throws
    }
  });

  it("imports a preview on the happy path (no cleanup) and records the pathname", async () => {
    const { sign, batchId } = await seedBatchWithSign("IMP2");
    happyFigmaPath(sign, "IMP2");
    vi.mocked(putPrivateImage).mockResolvedValue("sign-previews/IMP2-ok.png");

    const result = await importBatchPreviewsSlice(batchId, 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imported).toBe(1);
      expect(result.total).toBe(1);
      expect(result.done).toBe(true);
    }
    expect(deletePrivateImage).not.toHaveBeenCalled();
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after?.previewImagePath).toBe("sign-previews/IMP2-ok.png");
  });

  it("imports every sign in a small batch in one slice (bounded pool)", async () => {
    const itemIds = ["C1", "C2", "C3", "C4", "C5"];
    const signs = await Promise.all(itemIds.map((itemId) => seedSign({ itemId })));
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: signs.length,
        createdById: "u1",
        figmaUrl: "https://www.figma.com/design/abc123/DC34",
        signs: { connect: signs.map((s) => ({ id: s.id })) },
      },
      select: { id: true },
    });
    mockMatched(signs, itemIds);

    const result = await importBatchPreviewsSlice(batch.id, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imported).toBe(5);
      expect(result.processed).toBe(5);
      expect(result.done).toBe(true);
    }

    const rows = await prisma.sign.findMany({
      where: { id: { in: signs.map((s) => s.id) } },
      select: { previewImagePath: true },
    });
    expect(rows).toHaveLength(5);
    expect(
      rows.every((r) => r.previewImagePath?.startsWith("sign-previews/")),
    ).toBe(true);
  });

  it("walks a >50-sign batch across slices; cursor advances, audit only on done, idempotent re-run", async () => {
    const itemIds = Array.from({ length: 60 }, (_, i) => `SL${i}`);
    const signs = await Promise.all(itemIds.map((itemId) => seedSign({ itemId })));
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: signs.length,
        createdById: "u1",
        figmaUrl: "https://www.figma.com/design/abc123/DC34",
        signs: { connect: signs.map((s) => ({ id: s.id })) },
      },
      select: { id: true },
    });
    mockMatched(signs, itemIds);

    // Slice 1: 50 signs, not done, no audit yet.
    const s1 = await importBatchPreviewsSlice(batch.id, 0);
    expect(s1.ok).toBe(true);
    if (s1.ok) {
      expect(s1.processed).toBe(50);
      expect(s1.imported).toBe(50);
      expect(s1.nextOffset).toBe(50);
      expect(s1.total).toBe(60);
      expect(s1.done).toBe(false);
    }
    expect(
      await prisma.auditLog.count({ where: { action: "sign.import_previews" } }),
    ).toBe(0);

    // Slice 2: remaining 10, done, audit written once with a server-side recount.
    const s2 = await importBatchPreviewsSlice(batch.id, 50);
    expect(s2.ok).toBe(true);
    if (s2.ok) {
      expect(s2.processed).toBe(10);
      expect(s2.imported).toBe(10);
      expect(s2.nextOffset).toBe(60);
      expect(s2.done).toBe(true);
    }

    const done = await prisma.sign.count({
      where: {
        id: { in: signs.map((s) => s.id) },
        previewImagePath: { not: null },
      },
    });
    expect(done).toBe(60);

    const audit = await prisma.auditLog.findMany({
      where: { action: "sign.import_previews" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain("60/60 signs now have previews");

    // Idempotent re-run from offset 0 — safe, still ends at 60/60, second audit row.
    const again = await importBatchPreviewsSlice(batch.id, 0);
    expect(again.ok).toBe(true);
    expect(
      await prisma.sign.count({
        where: {
          id: { in: signs.map((s) => s.id) },
          previewImagePath: { not: null },
        },
      }),
    ).toBe(60);
  });

  it("reports unmatched signs in the coverage counts", async () => {
    const matchedSign = await seedSign({ itemId: "MS-OK" });
    const unmatchedSign = await seedSign({ itemId: "MS-NONE" });
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 2,
        createdById: "u1",
        figmaUrl: "https://www.figma.com/design/abc123/DC34",
        signs: { connect: [{ id: matchedSign.id }, { id: unmatchedSign.id }] },
      },
      select: { id: true },
    });
    mockMatched([matchedSign], ["MS-OK"], [
      { id: unmatchedSign.id, itemId: "MS-NONE" },
    ]);

    const result = await importBatchPreviewsSlice(batch.id, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imported).toBe(1);
      expect(result.total).toBe(1);
      expect(result.totalSigns).toBe(2);
      expect(result.unmatched).toBe(1);
      expect(result.done).toBe(true);
    }
  });

  it("returns { ok: false } with the Figma error when the document fetch fails (no per-sign work)", async () => {
    const { batchId } = await seedBatchWithSign("IMP3");
    vi.mocked(figmaToken).mockReturnValue("tok");
    vi.mocked(fetchFileDocument).mockRejectedValue(
      new Error("Figma file request failed (500)."),
    );

    const result = await importBatchPreviewsSlice(batchId, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Figma file request failed (500).");
      expect(result.nextOffset).toBe(0);
    }
    expect(putPrivateImage).not.toHaveBeenCalled();
  });

  it("returns a friendly { ok: false } when the Figma link is missing (no token/URL)", async () => {
    const sign = await seedSign({ itemId: "IMP4" });
    const batch = await prisma.generationBatch.create({
      data: {
        pipeline: "figma-mcp",
        signCount: 1,
        createdById: "u1",
        // no figmaUrl
        signs: { connect: { id: sign.id } },
      },
      select: { id: true },
    });
    vi.mocked(figmaToken).mockReturnValue("tok");

    const result = await importBatchPreviewsSlice(batch.id, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Save the Figma file link first.");
  });
});
