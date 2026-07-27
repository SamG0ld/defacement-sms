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
// Every action here is per-actor rate limited (#194) — mock the limiter like the
// sibling action suites so one shared 60/min budget can't make this suite flaky.
vi.mock("@/lib/ratelimit", () => ({
  checkMutationRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 59,
    reset: 0,
  })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkMutationRateLimit } from "@/lib/ratelimit";
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

  // #229: category is free text in the DB and only the <select> constrained it,
  // so a directly-called action could store "easel" — classified as an asset but
  // reconciled into its own bucket, silently understating the gap to order.
  it("canonicalizes a known category's casing", async () => {
    await addEquipmentType(form({ name: "TEST Lowercase", category: "  easel " }));
    const t = await prisma.equipmentType.findUnique({ where: { name: "TEST Lowercase" } });
    expect(t?.category).toBe("Easel");
  });

  it("refuses a category outside the known set", async () => {
    const url = await captureRedirect(
      addEquipmentType(form({ name: "TEST Bogus", category: "Easels" })),
    );
    expect(url).toMatch(/category/i);
    expect(await prisma.equipmentType.findUnique({ where: { name: "TEST Bogus" } })).toBeNull();
  });

  it("still accepts a blank category (consumable)", async () => {
    await addEquipmentType(form({ name: "TEST Blank", category: "" }));
    const t = await prisma.equipmentType.findUnique({ where: { name: "TEST Blank" } });
    expect(t?.category).toBeNull();
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

  // The allowlist can't strand a row that predates it: EquipmentManageRow
  // re-offers a legacy custom category, so submitting it unchanged must pass —
  // while switching to a NEW unknown value is refused (#229).
  it("lets an edit keep a pre-existing custom category", async () => {
    const t = await seedType("TEST Legacy", "Supplies");
    await updateEquipmentType(t.id, 2026, form({ name: "TEST Legacy Renamed", category: "Supplies" }));
    const updated = await prisma.equipmentType.findUnique({ where: { id: t.id } });
    expect(updated?.name).toBe("TEST Legacy Renamed");
    expect(updated?.category).toBe("Supplies");
  });

  it("refuses switching to a different unknown category", async () => {
    const t = await seedType("TEST Legacy2", "Supplies");
    const url = await captureRedirect(
      updateEquipmentType(t.id, 2026, form({ name: "TEST Legacy2", category: "Fasteners" })),
    );
    expect(url).toMatch(/category/i);
    expect((await prisma.equipmentType.findUnique({ where: { id: t.id } }))?.category).toBe(
      "Supplies",
    );
  });

  it("reports a missing item instead of a generic failure", async () => {
    const url = await captureRedirect(
      updateEquipmentType(99999999, 2026, form({ name: "TEST Ghost", category: "Stand" })),
    );
    expect(url).toMatch(/not found/i);
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

describe("per-actor mutation rate limit (#194)", () => {
  it("refuses a count save over budget, without writing", async () => {
    const t = await seedType("TEST Throttled");
    vi.mocked(checkMutationRateLimit).mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: 0,
    });

    const url = await captureRedirect(
      upsertInventory(t.id, 2026, form({ countStartOfCon: "7" })),
    );
    expect(url).toMatch(/too many changes/i);
    expect(
      await prisma.equipmentInventory.findUnique({
        where: { equipmentTypeId_year: { equipmentTypeId: t.id, year: 2026 } },
      }),
    ).toBeNull();
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
    // Easels required honors the Easel Y/N flag: only R2 is marked needsEasel
    // (qty 1), so 1 — R1 is a poster but unmarked, so it does NOT add an easel.
    expect((await rowFor("Easels Required"))?.countEndOfCon).toBe(1);
  });
});
