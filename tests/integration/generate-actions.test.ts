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

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  generateSelection,
  updateBatchFigmaUrl,
} from "@/app/(app)/signs/generate-actions";

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
    const a = await seedSign({ itemId: "G1" });
    const b = await seedSign({ itemId: "G2", status: "printed" });

    const url = await captureRedirect(generateSelection(idsForm([a.id, b.id])));
    expect(url).toMatch(/^\/signs\/generate\/\d+$/);

    const batchId = Number(url.split("/").pop());
    const batch = await prisma.generationBatch.findUnique({
      where: { id: batchId },
      include: { signs: { select: { id: true } } },
    });
    expect(batch).not.toBeNull();
    expect(batch!.signCount).toBe(2);
    expect(batch!.pipeline).toBe("figma-mcp");
    expect(batch!.createdById).toBe("u1");
    expect(new Set(batch!.signs.map((s) => s.id))).toEqual(new Set([a.id, b.id]));

    const signs = await prisma.sign.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { status: true, generationBatchId: true, generationPipeline: true },
    });
    expect(signs.every((s) => s.status === "generated")).toBe(true);
    expect(signs.every((s) => s.generationBatchId === batchId)).toBe(true);
    expect(signs.every((s) => s.generationPipeline === "figma-mcp")).toBe(true);

    const hist = await prisma.statusHistory.findMany({
      where: { signId: { in: [a.id, b.id] } },
    });
    expect(hist).toHaveLength(2);
    expect(hist.every((h) => h.newStatus === "generated")).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { action: "sign.generate" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain(`batch #${batchId}`);
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

  it("stores a valid https figma.com URL", async () => {
    const { id } = await makeBatch();
    const fd = new FormData();
    fd.set("figmaUrl", "https://www.figma.com/design/abc/DC34");
    const url = await captureRedirect(updateBatchFigmaUrl(id, fd));
    expect(url).toBe(`/signs/generate/${id}`);
    const after = await prisma.generationBatch.findUnique({ where: { id } });
    expect(after?.figmaUrl).toBe("https://www.figma.com/design/abc/DC34");
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
