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
import {
  executeSpecialtyBatch,
  previewSpecialtyBatch,
  type SpecialtyRowInput,
} from "@/app/(app)/signs/specialty/actions";
import { MAX_SPECIALTY_ROWS } from "@/app/(app)/signs/specialty/_limits";

const session = {
  user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

// Defaults line up with the "banner" taxonomy entry so a bare row() is valid
// on its own; individual fields are overridden per test.
function row(over: Partial<SpecialtyRowInput> = {}): SpecialtyRowInput {
  return {
    typeKey: "banner",
    itemId: "ITEM-1",
    signText: "Test Banner",
    size: "8'x20'",
    quantity: 1,
    doubleSided: false,
    zoneId: null,
    placementArea: null,
    deploymentSlot: null,
    notes: null,
    ...over,
  };
}

async function activeZoneId(): Promise<number> {
  const zone = await prisma.zone.findFirstOrThrow({ where: { isActive: true } });
  return zone.id;
}

// Zones are seeded reference data (not truncated between tests) — upsert a
// dedicated inactive one rather than mutating a real seeded zone.
async function inactiveZoneId(): Promise<number> {
  const zone = await prisma.zone.upsert({
    where: { zoneCode: "TEST-INACTIVE" },
    update: { isActive: false },
    create: {
      zoneCode: "TEST-INACTIVE",
      zoneName: "Test Inactive Zone",
      isActive: false,
    },
  });
  return zone.id;
}

function seedExistingSign(over: Record<string, unknown> = {}) {
  return prisma.sign.create({
    data: {
      itemId: "EXIST-1",
      signText: "Existing Banner",
      signType: "Banner (large-format)",
      size: "8'x20'",
      quantity: 1,
      doubleSided: false,
      needsEasel: false,
      category: "union_installed",
      printable: false,
      status: "pending",
      deploymentPriority: 2,
      ...over,
    },
  });
}

describe("previewSpecialtyBatch", () => {
  it("classifies valid rows with category/tagName derived from taxonomy", async () => {
    const preview = await previewSpecialtyBatch([
      row({ typeKey: "banner", itemId: "B-1", signText: "Main Banner" }),
      row({
        typeKey: "venue-map",
        itemId: "M-1",
        signText: "Hall Map",
        size: "4'x8' (printed)",
      }),
    ]);

    expect(preview.error).toBeNull();
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({
      status: "valid",
      category: "union_installed",
      tagName: "Banner",
      error: null,
    });
    expect(preview.rows[1]).toMatchObject({
      status: "valid",
      category: "ops_map",
      tagName: "Venue Map",
      error: null,
    });
    expect(preview.counts).toEqual({ valid: 2, invalid: 0, duplicate: 0, total: 2 });
  });

  it("flags an unknown typeKey as invalid", async () => {
    const preview = await previewSpecialtyBatch([row({ typeKey: "not-a-real-type" })]);
    expect(preview.rows[0]).toMatchObject({
      status: "invalid",
      error: "Unknown item type",
    });
  });

  it("flags empty signText as invalid", async () => {
    const preview = await previewSpecialtyBatch([row({ signText: "" })]);
    expect(preview.rows[0]).toMatchObject({
      status: "invalid",
      error: "Name/text is required",
    });
  });

  it("flags a deploymentSlot outside the DEPLOYMENT_SLOTS allowlist as invalid", async () => {
    const preview = await previewSpecialtyBatch([row({ deploymentSlot: "MONDAY_AM" })]);
    expect(preview.rows[0].status).toBe("invalid");
    expect(preview.rows[0].error).toBeTruthy();
  });

  it("flags an inactive zoneId as invalid", async () => {
    const zoneId = await inactiveZoneId();
    const preview = await previewSpecialtyBatch([row({ zoneId })]);
    expect(preview.rows[0]).toMatchObject({
      status: "invalid",
      error: "Selected zone is not available.",
    });
  });

  it("flags a nonexistent zoneId as invalid", async () => {
    const preview = await previewSpecialtyBatch([row({ zoneId: 999999 })]);
    expect(preview.rows[0]).toMatchObject({
      status: "invalid",
      error: "Selected zone is not available.",
    });
  });

  it("flags a row matching an existing sign (itemId + signText + size) as duplicate", async () => {
    await seedExistingSign();
    const preview = await previewSpecialtyBatch([
      row({ itemId: "EXIST-1", signText: "Existing Banner", size: "8'x20'" }),
    ]);
    expect(preview.rows[0].status).toBe("duplicate");
    expect(preview.counts).toEqual({ valid: 0, invalid: 0, duplicate: 1, total: 1 });
  });

  // Specialty intake shares signDedupKey with the CSV importer, so a formatting-only
  // room-code variant of the same booth is ONE identity — entering it a second time
  // no longer spawns a twin Sign row for the same physical item (#177).
  it("flags a variant room-code spelling of an existing sign as duplicate", async () => {
    await seedExistingSign({
      itemId: "W204, W205",
      signText: "Payment Village",
      size: "4'x8'",
    });
    const preview = await previewSpecialtyBatch([
      row({ itemId: "W204-W205", signText: "Payment Village", size: "4'x8'" }),
    ]);
    expect(preview.rows[0].status).toBe("duplicate");
  });

  it("flags a variant room-code spelling of an earlier row in the same batch", async () => {
    const preview = await previewSpecialtyBatch([
      row({ itemId: "W301, W302", signText: "Press Room", size: "4'x8'" }),
      row({ itemId: "W301-W302", signText: "Press Room", size: "4'x8'" }),
    ]);
    expect(preview.rows[0].status).toBe("valid");
    expect(preview.rows[1].status).toBe("duplicate");
  });

  it("does not collapse two signs that differ only by size", async () => {
    // The dedup tuple keys on size, so a room's sock and its meterboard stay distinct.
    const preview = await previewSpecialtyBatch([
      row({ itemId: "W401", signText: "Lock Pick Village", size: "4'x8'" }),
      row({ itemId: "W401", signText: "Lock Pick Village", size: "8'x20'" }),
    ]);
    expect(preview.rows.map((r) => r.status)).toEqual(["valid", "valid"]);
  });

  it("flags the second of two identical rows in one batch as duplicate; the first stays valid", async () => {
    const r = row({ itemId: "SAME-1", signText: "Same Item", size: "10x10" });
    const preview = await previewSpecialtyBatch([r, { ...r }]);
    expect(preview.rows[0].status).toBe("valid");
    expect(preview.rows[1].status).toBe("duplicate");
    expect(preview.counts).toEqual({ valid: 1, invalid: 0, duplicate: 1, total: 2 });
  });

  it("rejects a batch over MAX_SPECIALTY_ROWS with an error and no rows", async () => {
    const rows = Array.from({ length: MAX_SPECIALTY_ROWS + 1 }, (_, i) =>
      row({ itemId: `OVER-${i}`, signText: `Row ${i}` }),
    );
    const preview = await previewSpecialtyBatch(rows);
    expect(preview.error).toBeTruthy();
    expect(preview.rows).toHaveLength(0);
    expect(preview.counts).toEqual({ valid: 0, invalid: 0, duplicate: 0, total: 0 });
  });

  it("counts add up across a mixed valid/invalid/duplicate batch", async () => {
    await seedExistingSign({ itemId: "MIX-DUP", signText: "Mix Dup", size: "1x1" });
    const preview = await previewSpecialtyBatch([
      row({ itemId: "MIX-OK", signText: "Mix Ok" }),
      row({ typeKey: "not-a-real-type" }),
      row({ itemId: "MIX-DUP", signText: "Mix Dup", size: "1x1" }),
    ]);
    expect(preview.counts.total).toBe(3);
    expect(
      preview.counts.valid + preview.counts.invalid + preview.counts.duplicate,
    ).toBe(preview.counts.total);
    expect(preview.counts).toEqual({ valid: 1, invalid: 1, duplicate: 1, total: 3 });
  });
});

describe("executeSpecialtyBatch", () => {
  it("creates Sign rows with taxonomy-derived fields and persists submitted row data", async () => {
    const zoneId = await activeZoneId();
    const res = await executeSpecialtyBatch([
      row({
        typeKey: "banner",
        itemId: "EXEC-1",
        signText: "Exec Banner",
        size: "8'x20'",
        quantity: 3,
        zoneId,
        placementArea: "Main entrance",
        deploymentSlot: "WED_AM",
        notes: "handle with care",
      }),
    ]);
    expect(res).toEqual({ created: 1, skipped: 0, failed: 0 });

    const sign = await prisma.sign.findFirstOrThrow({ where: { itemId: "EXEC-1" } });
    expect(sign).toMatchObject({
      category: "union_installed",
      signType: "Banner (large-format)",
      printable: false,
      needsEasel: false,
      status: "pending",
      quantity: 3,
      size: "8'x20'",
      placementArea: "Main entrance",
      deploymentSlot: "WED_AM",
      notes: "handle with care",
      zoneId,
    });
  });

  it("upserts the tag by slug (creating it if absent) and assigns it to the created sign", async () => {
    // floor-graphic is not in the seeded reference tags — start from a clean slate.
    await prisma.signTag.deleteMany({ where: { slug: "floor-graphic" } });

    const res = await executeSpecialtyBatch([
      row({ typeKey: "floor-graphic", itemId: "FG-1", signText: "Floor Graphic 1" }),
    ]);
    expect(res.created).toBe(1);

    const tag = await prisma.signTag.findUniqueOrThrow({ where: { slug: "floor-graphic" } });
    expect(tag.name).toBe("Floor Graphic");

    const sign = await prisma.sign.findFirstOrThrow({ where: { itemId: "FG-1" } });
    const assignment = await prisma.signTagAssignment.findFirst({
      where: { signId: sign.id, tagId: tag.id },
    });
    expect(assignment).not.toBeNull();
  });

  it("writes a StatusHistory row per created sign (pending, added via specialty intake)", async () => {
    await executeSpecialtyBatch([
      row({ itemId: "SH-1", signText: "History Sign 1" }),
      row({ itemId: "SH-2", signText: "History Sign 2" }),
    ]);

    const signs = await prisma.sign.findMany({
      where: { itemId: { in: ["SH-1", "SH-2"] } },
    });
    expect(signs).toHaveLength(2);

    const history = await prisma.statusHistory.findMany({
      where: { signId: { in: signs.map((s) => s.id) } },
    });
    expect(history).toHaveLength(2);
    for (const h of history) {
      expect(h.oldStatus).toBeNull();
      expect(h.newStatus).toBe("pending");
      expect(h.notes).toBe("Added via specialty intake");
    }
  });

  it("writes exactly one AuditLog row per batch (action signs.specialty-intake)", async () => {
    await executeSpecialtyBatch([
      row({ itemId: "AL-1", signText: "Audit Sign 1" }),
      row({ itemId: "AL-2", signText: "Audit Sign 2" }),
    ]);

    const audit = await prisma.auditLog.findMany({
      where: { action: "signs.specialty-intake" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain("created 2");
  });

  it("skips duplicate and invalid rows without writing them; counts reflect the skip", async () => {
    await seedExistingSign({ itemId: "DUP-EXEC", signText: "Exists", size: "8'x20'" });

    const res = await executeSpecialtyBatch([
      row({ itemId: "OK-EXEC", signText: "New Exec Sign" }),
      row({ typeKey: "not-a-real-type" }),
      row({ itemId: "DUP-EXEC", signText: "Exists", size: "8'x20'" }),
    ]);

    expect(res).toEqual({ created: 1, skipped: 2, failed: 0 });
    // The pre-seeded existing sign + the one newly created row.
    expect(await prisma.sign.count()).toBe(2);
  });

  it("is idempotent on re-entry: re-running an identical batch creates 0 and skips all", async () => {
    const rows = [row({ itemId: "IDEMP-1", signText: "Idempotent Sign" })];

    const first = await executeSpecialtyBatch(rows);
    expect(first).toEqual({ created: 1, skipped: 0, failed: 0 });

    const second = await executeSpecialtyBatch(rows);
    expect(second).toEqual({ created: 0, skipped: 1, failed: 0 });

    expect(await prisma.sign.count()).toBe(1);
  });

  it("does not create duplicate SignTag rows for the same slug across separate batches", async () => {
    await prisma.signTag.deleteMany({ where: { slug: "wall-graphic" } });

    await executeSpecialtyBatch([
      row({ typeKey: "wall-graphic", itemId: "WG-1", signText: "Wall 1" }),
    ]);
    await executeSpecialtyBatch([
      row({ typeKey: "wall-graphic", itemId: "WG-2", signText: "Wall 2" }),
    ]);

    const tags = await prisma.signTag.findMany({ where: { slug: "wall-graphic" } });
    expect(tags).toHaveLength(1);
  });

  it("throws too-many-rows for a batch over MAX_SPECIALTY_ROWS", async () => {
    const rows = Array.from({ length: MAX_SPECIALTY_ROWS + 1 }, (_, i) =>
      row({ itemId: `TM-${i}`, signText: `Row ${i}` }),
    );
    await expect(executeSpecialtyBatch(rows)).rejects.toThrow("too-many-rows");
  });
});
