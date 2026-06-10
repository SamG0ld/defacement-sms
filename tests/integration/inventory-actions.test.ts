import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as sign-actions: mock the request-context APIs + auth, keep
// Prisma real. Server actions signal failure by throwing through redirect().
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
  addEquipmentType,
  deleteEquipmentType,
  recordSignMaterialHistory,
  updateEquipmentType,
  upsertInventory,
} from "@/app/(app)/inventory/actions";

const session = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(async () => {
  vi.clearAllMocks();
  // equipment_types isn't truncated by the global setup, so clean up our rows.
  await prisma.equipmentType.deleteMany({ where: { name: { startsWith: "TEST " } } });
});

async function captureRedirect(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { redirectUrl?: string }).redirectUrl;
    // Decode so assertions match the human message, not its URL-encoding
    // (encodeURIComponent → %20, URLSearchParams → +).
    if (url !== undefined) return decodeURIComponent(url.replace(/\+/g, " "));
    throw e;
  }
  throw new Error("expected a redirect, but none was thrown");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const seedType = (name: string, category: string | null = "Consumable") =>
  prisma.equipmentType.create({ data: { name, category } });

describe("addEquipmentType", () => {
  it("creates an item (no redirect on success) and audits it", async () => {
    await addEquipmentType(form({ name: "TEST Bolts", category: "Consumable" }));
    const t = await prisma.equipmentType.findUnique({ where: { name: "TEST Bolts" } });
    expect(t?.category).toBe("Consumable");
    const audit = await prisma.auditLog.findFirst({ where: { action: "equipment.add" } });
    expect(audit?.detail).toContain("TEST Bolts");
  });

  it("rejects a duplicate name", async () => {
    await seedType("TEST Dup");
    const url = await captureRedirect(addEquipmentType(form({ name: "TEST Dup" })));
    expect(url).toMatch(/already exists/i);
  });
});

describe("updateEquipmentType", () => {
  it("renames and recategorizes", async () => {
    const t = await seedType("TEST Old", "Consumable");
    await updateEquipmentType(t.id, 2026, form({ name: "TEST New", category: "Stand" }));
    const updated = await prisma.equipmentType.findUnique({ where: { id: t.id } });
    expect(updated?.name).toBe("TEST New");
    expect(updated?.category).toBe("Stand");
  });

  it("rejects renaming onto an existing name (P2002)", async () => {
    const a = await seedType("TEST A");
    await seedType("TEST B");
    const url = await captureRedirect(
      updateEquipmentType(a.id, 2026, form({ name: "TEST B", category: "Consumable" })),
    );
    expect(url).toMatch(/already exists/i);
    // a unchanged
    expect((await prisma.equipmentType.findUnique({ where: { id: a.id } }))?.name).toBe(
      "TEST A",
    );
  });

  it("audits the update", async () => {
    const t = await seedType("TEST Audit");
    await updateEquipmentType(t.id, 2026, form({ name: "TEST Audited", category: "Stand" }));
    const audit = await prisma.auditLog.findFirst({ where: { action: "equipment.update" } });
    expect(audit?.detail).toContain("TEST Audited");
  });
});

describe("deleteEquipmentType", () => {
  it("deletes an item with no inventory history (and audits it)", async () => {
    const t = await seedType("TEST Disposable");
    await deleteEquipmentType(t.id, 2026);
    expect(await prisma.equipmentType.findUnique({ where: { id: t.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "equipment.delete" } });
    expect(audit?.detail).toContain("TEST Disposable");
  });

  it("refuses to delete an item that has saved counts", async () => {
    const t = await seedType("TEST HasHistory");
    await upsertInventory(t.id, 2025, form({ countEndOfCon: "12" }));
    const url = await captureRedirect(deleteEquipmentType(t.id, 2026));
    expect(url).toMatch(/saved counts|history/i);
    // Still present — the guard protected it.
    expect(await prisma.equipmentType.findUnique({ where: { id: t.id } })).not.toBeNull();
  });
});

describe("upsertInventory", () => {
  it("round-trips counts for a (type, year)", async () => {
    const t = await seedType("TEST Counted");
    await upsertInventory(
      t.id,
      2026,
      form({
        countStartOfCon: "10",
        countOrdered: "5",
        countReceived: "3",
        countEndOfCon: "8",
        notes: "carried over",
      }),
    );
    const inv = await prisma.equipmentInventory.findUnique({
      where: { equipmentTypeId_year: { equipmentTypeId: t.id, year: 2026 } },
    });
    expect(inv).toMatchObject({
      countStartOfCon: 10,
      countOrdered: 5,
      countReceived: 3,
      countEndOfCon: 8,
      notes: "carried over",
    });
  });

  it("only writes submitted fields (consumable form omits end-of-con)", async () => {
    const t = await seedType("TEST Partial");
    // Seed a row with a non-zero end-of-con, then save WITHOUT that field.
    await upsertInventory(t.id, 2026, form({ countEndOfCon: "9" }));
    await upsertInventory(t.id, 2026, form({ countStartOfCon: "4" }));
    const inv = await prisma.equipmentInventory.findUnique({
      where: { equipmentTypeId_year: { equipmentTypeId: t.id, year: 2026 } },
    });
    expect(inv?.countStartOfCon).toBe(4);
    expect(inv?.countEndOfCon).toBe(9); // preserved, not zeroed
  });
});

describe("recordSignMaterialHistory", () => {
  it("snapshots the live sign material totals into the given year's history", async () => {
    // Two 22x28 signs + one easel-needing sign.
    await prisma.sign.create({
      data: { itemId: "R1", signText: "A", signType: "Sign", size: "22x28", quantity: 2 },
    });
    await prisma.sign.create({
      data: {
        itemId: "R2",
        signText: "B",
        signType: "Sign",
        size: "24x36",
        quantity: 1,
        needsEasel: true,
      },
    });

    await recordSignMaterialHistory(2025);

    const rowFor = async (name: string) => {
      const t = await prisma.equipmentType.findUnique({ where: { name } });
      return t
        ? prisma.equipmentInventory.findUnique({
            where: { equipmentTypeId_year: { equipmentTypeId: t.id, year: 2025 } },
          })
        : null;
    };
    expect((await rowFor("Signs 22x28"))?.countEndOfCon).toBe(2);
    expect((await rowFor("Signs 24x36"))?.countEndOfCon).toBe(1);
    // Easels required is derived from the poster sizes: 22x28 (2) + 24x36 (1) = 3.
    expect((await rowFor("Easels Required"))?.countEndOfCon).toBe(3);
  });
});
