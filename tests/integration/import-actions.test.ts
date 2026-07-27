import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/ratelimit", () => ({
  checkActionRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 99,
    reset: 0,
  })),
  checkAuthRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 99,
    reset: 0,
  })),
  isRateLimitConfigured: () => false,
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { executeImport, previewImport } from "@/app/(app)/signs/import/actions";

const session = {
  user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
};
beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

const CSV = "Map#,Sign Text,Qty\nA1,Sign One,2\nA2,Sign Two,1";

it("imports valid rows as test data with per-sign history + an audit row", async () => {
  const res = await executeImport(CSV, false, true, "generic");
  expect(res.imported).toBe(2);

  const signs = await prisma.sign.findMany({ orderBy: { itemId: "asc" } });
  expect(signs).toHaveLength(2);
  expect(signs.every((s) => s.isTestData)).toBe(true);
  expect(signs.every((s) => s.status === "pending")).toBe(true);

  const hist = await prisma.statusHistory.findMany({
    orderBy: { id: "asc" },
  });
  expect(hist).toHaveLength(2);
  expect(hist[0].notes).toBe("Imported from CSV");

  const audit = await prisma.auditLog.findMany({
    where: { action: "signs.import" },
  });
  expect(audit).toHaveLength(1);
  expect(audit[0].detail).toContain("Imported 2 signs");
});

it("skips rows already in the DB when includeDuplicates is false", async () => {
  await executeImport(CSV, false, true, "generic");
  const res = await executeImport(CSV, false, true, "generic");
  expect(res.imported).toBe(0);
  expect(res.skipped).toBe(2);
  expect(await prisma.sign.count()).toBe(2);
});

// #265: re-importing a sheet row whose sign was REMOVED is a re-add, not a
// duplicate. Before the fix loadContext() read every sign with no `where`, so the
// tombstone poisoned the dedup set: the preview said DUPLICATE and the write was
// gated behind "also import the N likely-duplicate rows" — decline it (which the
// label invites) and the sign silently never gets produced.
describe("re-adding a removed sign (#265)", () => {
  const ONE = "Map#,Sign Text,Qty\nA1,Sign One,2";

  async function archiveEverything() {
    await prisma.sign.updateMany({ data: { status: "archived" as never } });
  }

  it("previews as readd (not duplicate) once the original is removed", async () => {
    await executeImport(ONE, false, false, "generic");
    await archiveEverything();

    const preview = await previewImport(ONE, "generic");
    expect(preview.counts.readd).toBe(1);
    expect(preview.counts.duplicate).toBe(0);
    expect(preview.rows[0].status).toBe("readd");
  });

  it("imports the re-add WITHOUT the likely-duplicate opt-in, keeping the tombstone", async () => {
    await executeImport(ONE, false, false, "generic");
    await archiveEverything();

    const res = await executeImport(ONE, false, false, "generic");
    expect(res.imported).toBe(1);
    expect(res.error).toBeUndefined(); // the #263 index exempts archived — no P2002

    const rows = await prisma.sign.findMany({ where: { itemId: "A1" } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "archived")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  // The dedup key is (room, text, size); the DB's uniqueness identity is (room,
  // sheetName, category). They diverge whenever a space's printed text changes
  // while its sheet Name stays put, so a row can look like a fresh re-add and
  // still be rejected by Postgres. Re-adds import unattended and the insert is
  // ONE transaction, so an un-demoted re-add takes the WHOLE import down —
  // strictly worse than the pre-#265 behaviour, which just skipped the row.
  it("a re-add whose sheet identity is already live stays a duplicate — the rest of the import still lands", async () => {
    const MASTER = [
      "ID,Department,Name,Hall,Level 1,Booth/Room #",
      "3144,Village Department,Crypto Village,W2,Level 1,601",
    ].join("\n");

    // First import creates the space's signs (primary + its sock), sheetName =
    // the space Name.
    const first = await executeImport(MASTER, false, false, "master");
    expect(first.imported).toBeGreaterThan(0);

    // Remove one of them, then let a live sign take over its exact sheet identity
    // with different printed text — the shape a text change leaves behind.
    const target = await prisma.sign.findFirstOrThrow({
      where: { sheetName: "Crypto Village" },
    });
    await prisma.sign.update({
      where: { id: target.id },
      data: { status: "archived" as never },
    });
    await prisma.sign.create({
      data: {
        itemId: target.itemId,
        signText: "CRYPTO", // the printed text moved on; the sheet Name did not
        signType: target.signType,
        size: target.size,
        sheetName: target.sheetName,
        category: target.category,
      },
    });

    const preview = await previewImport(MASTER, "master");
    const row = preview.rows.find(
      (r) => r.data.size === target.size && r.data.signText === target.signText,
    );
    expect(row?.status).toBe("duplicate");
    expect(row?.reason).toMatch(/still in the record/i);

    // Not a "0 imported, everything rolled back" outcome: the row is skipped and
    // the transaction commits.
    const again = await executeImport(MASTER, false, false, "master");
    expect(again.error).toBeUndefined();
    expect(
      (await prisma.sign.findUnique({ where: { id: target.id } }))?.status,
    ).toBe("archived");
  });

  it("a LIVE twin still reads as a duplicate and still needs the opt-in", async () => {
    await executeImport(ONE, false, false, "generic");
    await archiveEverything();
    await executeImport(ONE, false, false, "generic"); // the re-add, now live

    const preview = await previewImport(ONE, "generic");
    expect(preview.counts.duplicate).toBe(1);
    expect(preview.counts.readd).toBe(0);

    const res = await executeImport(ONE, false, false, "generic");
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(await prisma.sign.count({ where: { itemId: "A1" } })).toBe(2);
  });
});

it("throws when the file exceeds the row cap", async () => {
  const header = "Map#,Sign Text,Qty\n";
  const rows = Array.from(
    { length: 2001 },
    (_, i) => `R${i},Sign ${i},1`,
  ).join("\n");
  await expect(
    executeImport(header + rows, false, true, "generic"),
  ).rejects.toThrow("too-many-rows");
});
