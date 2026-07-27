import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking strategy as sign-actions: redirect/revalidate/auth are mocked,
// Prisma is real. Every bulk action ends in redirect() (success OR failure), so
// all calls are wrapped in captureRedirect.
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
  bulkAddTag,
  bulkDelete,
  bulkRemoveTag,
  bulkSetFormat,
  bulkSetHardwareCollected,
  bulkSetHardwareReturned,
  bulkSetSlot,
  bulkSetStatus,
  bulkSetZone,
} from "@/app/(app)/signs/bulk-actions";
import { formatForKey } from "@/lib/sign-format";

const admin = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "admin" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(admin as never);
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

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function seed(over: Record<string, unknown> = {}) {
  return prisma.sign.create({
    data: {
      itemId: "SEED",
      signText: "Seed",
      signType: "Sign",
      size: "22x28",
      ...over,
    },
  });
}

const ids = (xs: { id: number }[]) => JSON.stringify(xs.map((x) => x.id));

describe("bulkSetStatus", () => {
  it("sets every selected id to a target status with one history row each", async () => {
    const a = await seed({ itemId: "A" });
    const b = await seed({ itemId: "B" });
    const c = await seed({ itemId: "C", status: "deployed" }); // not selected

    const url = await captureRedirect(
      bulkSetStatus(form({ ids: ids([a, b]), setStatus: "deployed" })),
    );
    expect(url).not.toContain("error=");

    const rows = await prisma.sign.findMany({
      where: { id: { in: [a.id, b.id] } },
    });
    expect(rows.every((r) => r.status === "deployed")).toBe(true);
    expect(rows.every((r) => r.deployedAt !== null)).toBe(true);
    expect(rows.every((r) => r.deliveredAt === null)).toBe(true); // skipped delivered
    const hist = await prisma.statusHistory.findMany({
      where: { signId: { in: [a.id, b.id] } },
    });
    expect(hist).toHaveLength(2);
    // c was untouched
    expect((await prisma.sign.findUnique({ where: { id: c.id } }))?.status).toBe(
      "deployed",
    );
  });

  it("skips rows already at the target (no no-op history)", async () => {
    const a = await seed({ itemId: "A", status: "printed" });
    await captureRedirect(
      bulkSetStatus(form({ ids: ids([a]), setStatus: "printed" })),
    );
    const hist = await prisma.statusHistory.count({ where: { signId: a.id } });
    expect(hist).toBe(0);
  });

  it("acts on ALL rows matching the filter, not just an explicit id list", async () => {
    await seed({ itemId: "P1", signType: "Banner" });
    await seed({ itemId: "P2", signType: "Banner" });
    await seed({ itemId: "X1", signType: "Poster" });

    await captureRedirect(
      bulkSetStatus(form({ allMatching: "1", type: "Banner", setStatus: "deployed" })),
    );
    expect(
      await prisma.sign.count({
        where: { signType: "Banner", status: "deployed" },
      }),
    ).toBe(2);
    expect(
      await prisma.sign.count({
        where: { signType: "Poster", status: "deployed" },
      }),
    ).toBe(0);
  });

  it("rejects an empty selection", async () => {
    const url = await captureRedirect(
      bulkSetStatus(form({ ids: "[]", setStatus: "deployed" })),
    );
    expect(url).toContain("error=");
  });
});

describe("bulkSetZone / bulkDelete (lead+)", () => {
  it("reassigns the zone of selected signs", async () => {
    const zone = await prisma.zone.findFirst({ where: { isActive: true } });
    expect(zone).not.toBeNull();
    const a = await seed({ itemId: "Z1" });
    await captureRedirect(
      bulkSetZone(form({ ids: ids([a]), zoneId: String(zone!.id) })),
    );
    expect((await prisma.sign.findUnique({ where: { id: a.id } }))?.zoneId).toBe(
      zone!.id,
    );
  });

  it("deletes selected signs (cascading history)", async () => {
    const a = await seed({ itemId: "D1" });
    await captureRedirect(bulkDelete(form({ ids: ids([a]) })));
    expect(await prisma.sign.findUnique({ where: { id: a.id } })).toBeNull();
  });
});

describe("bulkSetFormat (lead+)", () => {
  it("applies the format's size/type/category/double-sided but leaves needsEasel untouched", async () => {
    const dbl = formatForKey("meterboard-double")!;
    // Seed a foamcore easel (needsEasel true) — deliberately NOT the target format's
    // easel default (false), so we can prove needsEasel survives the reformat.
    const a = await seed({
      itemId: "F1",
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
      needsEasel: true,
    });

    await captureRedirect(
      bulkSetFormat(form({ ids: ids([a]), setFormat: "meterboard-double" })),
    );

    const after = await prisma.sign.findUnique({ where: { id: a.id } });
    expect(after).toMatchObject({
      size: dbl.size,
      signType: dbl.signType,
      category: dbl.category,
      doubleSided: dbl.doubleSided, // true — double is part of the format
    });
    expect(after?.needsEasel).toBe(true); // independent marking, NOT reset to the default
  });

  it("rejects an unknown format key without writing", async () => {
    const a = await seed({ itemId: "F2", size: "22x28", signType: '22"x28"' });
    const url = await captureRedirect(
      bulkSetFormat(form({ ids: ids([a]), setFormat: "not-a-format" })),
    );
    expect(url).toMatch(/error=/);
    const after = await prisma.sign.findUnique({ where: { id: a.id } });
    expect(after?.size).toBe("22x28"); // unchanged
  });

  it("writes a format history row per CHANGED sign with old→new labels", async () => {
    const dbl = formatForKey("meterboard-double")!;
    const a = await seed({
      itemId: "FH1",
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
    });
    const b = await seed({
      itemId: "FH2",
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
    });

    await captureRedirect(
      bulkSetFormat(form({ ids: ids([a, b]), setFormat: "meterboard-double" })),
    );

    const hist = await prisma.statusHistory.findMany({
      where: { signId: { in: [a.id, b.id] }, changeType: "format" },
    });
    expect(hist).toHaveLength(2);
    for (const h of hist) {
      expect(h).toMatchObject({
        changeType: "format",
        oldStatus: "Foamcore 22×28",
        newStatus: dbl.label,
        changedBy: "lead@example.com",
      });
    }
    // The specific audit names the changed count.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "bulk.format" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.detail).toContain("2 of 2 changed");
  });

  it("writes NO format row for a no-op (sign already in the target format)", async () => {
    const dbl = formatForKey("meterboard-double")!;
    const a = await seed({
      itemId: "FH3",
      size: dbl.size,
      signType: dbl.signType,
      category: dbl.category,
      doubleSided: dbl.doubleSided,
    });
    await captureRedirect(
      bulkSetFormat(form({ ids: ids([a]), setFormat: "meterboard-double" })),
    );
    expect(
      await prisma.statusHistory.count({
        where: { signId: a.id, changeType: "format" },
      }),
    ).toBe(0);
  });

  it("logs a same-SIZE tuple change (category differs) — guards the full-tuple diff", async () => {
    // A mis-typed row whose size already equals the target's, but whose category is
    // wrong. Keying the diff on size alone would drop this real reformat; the label
    // must not borrow the canonical foamcore label either.
    const a = await seed({
      itemId: "FH4",
      size: "24x36",
      signType: '24"x36"',
      category: "ops_map",
      doubleSided: false,
    });
    await captureRedirect(
      bulkSetFormat(form({ ids: ids([a]), setFormat: "foamcore-24x36" })),
    );
    const hist = await prisma.statusHistory.findMany({
      where: { signId: a.id, changeType: "format" },
    });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      oldStatus: "24x36", // raw size — NOT borrowed "Foamcore 24×36"
      newStatus: "Foamcore 24×36",
    });
    // …and the category was actually normalized.
    expect((await prisma.sign.findUnique({ where: { id: a.id } }))?.category).toBe(
      "easel_sign",
    );
  });
});

describe("bulkAddTag / bulkRemoveTag (lead+)", () => {
  it("adds then removes a tag across the selection", async () => {
    const tag = await prisma.signTag.findFirst();
    expect(tag).not.toBeNull();
    const a = await seed({ itemId: "T1" });
    const b = await seed({ itemId: "T2" });

    await captureRedirect(
      bulkAddTag(form({ ids: ids([a, b]), tagId: String(tag!.id) })),
    );
    expect(
      await prisma.signTagAssignment.count({ where: { tagId: tag!.id } }),
    ).toBe(2);

    // Idempotent add (skipDuplicates) — still 2.
    await captureRedirect(
      bulkAddTag(form({ ids: ids([a, b]), tagId: String(tag!.id) })),
    );
    expect(
      await prisma.signTagAssignment.count({ where: { tagId: tag!.id } }),
    ).toBe(2);

    await captureRedirect(
      bulkRemoveTag(form({ ids: ids([a, b]), tagId: String(tag!.id) })),
    );
    expect(
      await prisma.signTagAssignment.count({ where: { tagId: tag!.id } }),
    ).toBe(0);
  });

  it("rejects bulk add/remove of the master-sheet system tag", async () => {
    // The master-sheet tag gates reconcile scope, so it must not be user-editable —
    // even via a hand-crafted POST that bypasses the (hidden-from-UI) picker.
    const ms = await prisma.signTag.findUniqueOrThrow({
      where: { slug: "master-sheet" },
    });
    const a = await seed({ itemId: "SYS-BULK" });

    const addUrl = await captureRedirect(
      bulkAddTag(form({ ids: ids([a]), tagId: String(ms.id) })),
    );
    expect(addUrl).toContain("error=");
    expect(
      await prisma.signTagAssignment.count({
        where: { signId: a.id, tagId: ms.id },
      }),
    ).toBe(0);

    // And removal is rejected too (can't strip it off a sign that has it).
    await prisma.signTagAssignment.create({
      data: { signId: a.id, tagId: ms.id },
    });
    const removeUrl = await captureRedirect(
      bulkRemoveTag(form({ ids: ids([a]), tagId: String(ms.id) })),
    );
    expect(removeUrl).toContain("error=");
    expect(
      await prisma.signTagAssignment.count({
        where: { signId: a.id, tagId: ms.id },
      }),
    ).toBe(1);
  });
});

describe("bulkSetHardwareCollected", () => {
  it("marks hardware collected across the selection", async () => {
    const a = await seed({ itemId: "BHW1", needsEasel: true });
    const b = await seed({ itemId: "BHW2", needsEasel: true });
    await captureRedirect(
      bulkSetHardwareCollected(form({ ids: ids([a, b]), collected: "1" })),
    );
    const rows = await prisma.sign.findMany({
      where: { id: { in: [a.id, b.id] } },
    });
    expect(rows.every((r) => r.equipmentCheckedOut)).toBe(true);
  });
});

describe("bulkSetHardwareReturned", () => {
  it("marks hardware returned across the selection and audits", async () => {
    const a = await seed({ itemId: "BHR1", needsEasel: true, equipmentCheckedOut: true });
    const b = await seed({ itemId: "BHR2", needsEasel: true, equipmentCheckedOut: true });
    await captureRedirect(
      bulkSetHardwareReturned(form({ ids: ids([a, b]), returned: "1" })),
    );
    const rows = await prisma.sign.findMany({
      where: { id: { in: [a.id, b.id] } },
    });
    expect(rows.every((r) => r.equipmentReturned)).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "bulk.hardware_return" },
    });
    expect(audit?.actorId).toBe("u1");
    expect(audit?.detail).toContain("returned");
  });
});

// #172: the BulkBar hides these actions on the Removed view, but that gate is
// client-only — the forms POST straight to the bound Server Actions. Both target
// kinds need the server-side exclusion: an explicit `ids` selection never
// filtered on status at all, and an `allMatching` selection built on the Removed
// view resolves to `status = archived` by design.
describe("archived signs are excluded from every bulk edit (#172)", () => {
  async function archived(itemId: string, over: Record<string, unknown> = {}) {
    return seed({ itemId, status: "archived", ...over });
  }

  it("bulkSetZone / bulkSetSlot / hardware leave archived rows untouched (explicit ids)", async () => {
    const zone = await prisma.zone.findFirst({ where: { isActive: true } });
    const gone = await archived("ARCH-Z");

    await captureRedirect(
      bulkSetZone(form({ ids: ids([gone]), zoneId: String(zone!.id) })),
    );
    await captureRedirect(
      bulkSetSlot(form({ ids: ids([gone]), setSlot: "WED_AM" })),
    );
    await captureRedirect(
      bulkSetHardwareCollected(form({ ids: ids([gone]), collected: "1" })),
    );

    const after = await prisma.sign.findUnique({ where: { id: gone.id } });
    expect(after?.zoneId).toBeNull();
    expect(after?.deploymentSlot).toBeNull();
    expect(after?.equipmentCheckedOut).toBe(false);
    expect(after?.status).toBe("archived");
  });

  it("bulkSetZone leaves archived rows untouched on the Removed view (allMatching)", async () => {
    const zone = await prisma.zone.findFirst({ where: { isActive: true } });
    const gone = await archived("ARCH-ALL");

    await captureRedirect(
      bulkSetZone(
        form({ allMatching: "1", status: "archived", zoneId: String(zone!.id) }),
      ),
    );
    expect(
      (await prisma.sign.findUnique({ where: { id: gone.id } }))?.zoneId,
    ).toBeNull();
  });

  it("bulkSetFormat leaves archived rows untouched and writes no format history", async () => {
    const gone = await archived("ARCH-F", {
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
    });

    await captureRedirect(
      bulkSetFormat(form({ ids: ids([gone]), setFormat: "meterboard-double" })),
    );

    const after = await prisma.sign.findUnique({ where: { id: gone.id } });
    expect(after?.size).toBe("22x28");
    expect(after?.doubleSided).toBe(false);
    expect(
      await prisma.statusHistory.count({
        where: { signId: gone.id, changeType: "format" },
      }),
    ).toBe(0);
  });

  it("bulkAddTag / bulkRemoveTag skip archived rows (both target kinds)", async () => {
    const tag = await prisma.signTag.findFirst();
    const gone = await archived("ARCH-T");

    await captureRedirect(
      bulkAddTag(form({ ids: ids([gone]), tagId: String(tag!.id) })),
    );
    expect(
      await prisma.signTagAssignment.count({
        where: { signId: gone.id, tagId: tag!.id },
      }),
    ).toBe(0);

    // Removal must not strip a tag an archived sign already carries — that would
    // change what it comes back as on Restore.
    await prisma.signTagAssignment.create({
      data: { signId: gone.id, tagId: tag!.id },
    });
    await captureRedirect(
      bulkRemoveTag(form({ ids: ids([gone]), tagId: String(tag!.id) })),
    );
    await captureRedirect(
      bulkRemoveTag(
        form({ allMatching: "1", status: "archived", tagId: String(tag!.id) }),
      ),
    );
    expect(
      await prisma.signTagAssignment.count({
        where: { signId: gone.id, tagId: tag!.id },
      }),
    ).toBe(1);
  });

  it("still edits live signs in a mixed selection", async () => {
    // The guard must narrow the write, not reject the whole call.
    const zone = await prisma.zone.findFirst({ where: { isActive: true } });
    const live = await seed({ itemId: "MIX-L", status: "generated" });
    const gone = await archived("MIX-A");

    await captureRedirect(
      bulkSetZone(form({ ids: ids([live, gone]), zoneId: String(zone!.id) })),
    );
    expect(
      (await prisma.sign.findUnique({ where: { id: live.id } }))?.zoneId,
    ).toBe(zone!.id);
    expect(
      (await prisma.sign.findUnique({ where: { id: gone.id } }))?.zoneId,
    ).toBeNull();
  });
});

// #232: handed_off / installed are the external-item terminals. Reachable on any
// class before, which stamped handedOffAt/installedAt while the structured
// lifecycle fields stayed null and LifecyclePanel never rendered.
describe("bulkSetStatus — handed_off/installed are external-item only (#232)", () => {
  it("skips non-external rows and says so", async () => {
    const easel = await seed({ itemId: "EXT-E", category: "easel_sign", status: "delivered" });
    const banner = await seed({
      itemId: "EXT-U",
      category: "union_installed",
      status: "delivered",
    });

    const url = await captureRedirect(
      bulkSetStatus(form({ ids: ids([easel, banner]), setStatus: "installed" })),
    );
    expect(url).toContain("notice=");
    expect(url).toContain("skipped");

    expect(
      (await prisma.sign.findUnique({ where: { id: easel.id } }))?.status,
    ).toBe("delivered");
    expect(
      (await prisma.sign.findUnique({ where: { id: banner.id } }))?.status,
    ).toBe("installed");
    // No stamps, no history for the sign that was refused.
    expect(
      (await prisma.sign.findUnique({ where: { id: easel.id } }))?.installedAt,
    ).toBeNull();
    expect(await prisma.statusHistory.count({ where: { signId: easel.id } })).toBe(0);
  });

  it("errors when the whole selection is the wrong item class", async () => {
    const easel = await seed({ itemId: "EXT-ONLY", category: "socks", status: "delivered" });
    const url = await captureRedirect(
      bulkSetStatus(form({ ids: ids([easel]), setStatus: "handed_off" })),
    );
    expect(url).toContain("error=");
    expect(
      (await prisma.sign.findUnique({ where: { id: easel.id } }))?.status,
    ).toBe("delivered");
  });
});

describe("authorization", () => {
  it("restricts a volunteer's bulk-set-status to their claimed signs and blocks bulk-delete", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "vol@example.com", isActive: true, role: "volunteer" },
    } as never);
    const a = await seed({ itemId: "AUTH1" }); // unclaimed → not the volunteer's

    // status: the volunteer holds no claim on this sign, so the bulk-set is
    // intersected to nothing — a no-op, not an overwrite (H2/#20). (The positive
    // claimed-signs case is covered in tests/integration/sign-status-authz.test.ts.)
    await captureRedirect(
      bulkSetStatus(form({ ids: ids([a]), setStatus: "printed" })),
    );
    expect((await prisma.sign.findUnique({ where: { id: a.id } }))?.status).toBe(
      "pending",
    );

    // delete: blocked (requireRole throws)
    await expect(bulkDelete(form({ ids: ids([a]) }))).rejects.toThrow(/role/i);
    expect(await prisma.sign.findUnique({ where: { id: a.id } })).not.toBeNull();
  });
});
