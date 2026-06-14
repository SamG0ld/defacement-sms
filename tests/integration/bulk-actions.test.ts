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
  bulkSetHardwareCollected,
  bulkSetStatus,
  bulkSetZone,
} from "@/app/(app)/signs/bulk-actions";

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
