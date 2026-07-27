import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
// Deterministic: never let a real rate limiter (or its absence) flake the suite.
vi.mock("@/lib/ratelimit", () => ({
  checkActionRateLimit: vi.fn(async () => ({ success: true })),
  checkMutationRateLimit: vi.fn(async () => ({ success: true })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { applyAutoPin, previewAutoPin } from "@/app/(app)/signs/pin/actions";
import type { FloorMapRule } from "@/lib/auto-pin";

// Prefix rules keyed on codes that can't collide with real rooms; no hyphens so
// nothing here is mistaken for a range. APW2xx→L2, APW3xx→L3.
const RULES: FloorMapRule[] = [
  { match: "prefix", value: "APW2", floorMapKey: "lvcc-west-l2" },
  { match: "prefix", value: "APW3", floorMapKey: "lvcc-west-l3" },
];

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    user: { id: "admin1", email: "admin@example.com", isActive: true, role: "admin" },
  } as never);
});
afterEach(async () => {
  vi.clearAllMocks();
  // signs + audit are truncated by the global setup; locations + floor maps are not.
  await prisma.location.deleteMany({ where: { locationCode: { startsWith: "APW" } } });
  await prisma.floorMap.deleteMany({ where: { key: { startsWith: "apw-" } } });
});

async function mapId(key: string): Promise<number> {
  return (await prisma.floorMap.findUniqueOrThrow({ where: { key } })).id;
}

let signSeq = 0;
async function makeSign(
  exactDestination: string | null,
  over: Record<string, unknown> = {},
) {
  signSeq += 1;
  return prisma.sign.create({
    data: {
      itemId: `AP${signSeq}`,
      signText: "T",
      signType: "Sign",
      size: "22x28",
      isTestData: false,
      exactDestination,
      ...over,
    },
  });
}

describe("applyAutoPin", () => {
  it("creates a room on the inferred map, deriving zone from the map, and links the sign", async () => {
    const sign = await makeSign("APW301");
    const res = await applyAutoPin(RULES, {});
    expect(res.created).toBe(1);
    expect(res.linked).toBe(1);

    // The seeded lvcc-west-l3 map IS zone-linked (LVCC-L3), so the created room
    // inherits that zone (createRoom parity) rather than a hardcoded default.
    const l3Zone = await prisma.zone.findUniqueOrThrow({ where: { zoneCode: "LVCC-L3" } });
    const room = await prisma.location.findUniqueOrThrow({
      where: { locationCode: "APW301" },
    });
    expect(room.floorMapId).toBe(await mapId("lvcc-west-l3"));
    expect(room.zoneId).toBe(l3Zone.id);
    expect(room.building).toBe(l3Zone.building ?? "LVCC West");

    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.locationId).toBe(room.id);
  });

  it("leaves zone null when the target map has no zone (the DC34 case)", async () => {
    // A throwaway zone-less map — the real DC34 state (maps uploaded without a
    // zone link). building falls back to "LVCC West", zoneId/floor stay null.
    const fm = await prisma.floorMap.create({
      data: {
        key: "apw-zoneless",
        label: "APW zoneless",
        imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        sortOrder: 999,
      },
    });
    const sign = await makeSign("APW901");
    await applyAutoPin(
      [{ match: "prefix", value: "APW9", floorMapKey: "apw-zoneless" }],
      {},
    );
    const room = await prisma.location.findUniqueOrThrow({
      where: { locationCode: "APW901" },
    });
    expect(room.floorMapId).toBe(fm.id);
    expect(room.zoneId).toBeNull();
    expect(room.floor).toBeNull();
    expect(room.building).toBe("LVCC West");
    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.locationId).toBe(room.id);
  });

  it("links to an existing placed room without creating one", async () => {
    const room = await prisma.location.create({
      data: {
        locationCode: "APW201",
        building: "LVCC West",
        floorMapId: await mapId("lvcc-west-l2"),
        mapX: 50,
        mapY: 50,
      },
    });
    const sign = await makeSign("APW201");
    const res = await applyAutoPin(RULES, {});
    expect(res.created).toBe(0);
    expect(res.linked).toBe(1);
    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.locationId).toBe(room.id);
  });

  it("re-homes an orphaned existing room onto its map and links", async () => {
    const room = await prisma.location.create({
      data: { locationCode: "APW202", building: "LVCC West", floorMapId: null },
    });
    const sign = await makeSign("APW202");
    const res = await applyAutoPin(RULES, {});
    expect(res.rehomed).toBe(1);
    const roomAfter = await prisma.location.findUniqueOrThrow({ where: { id: room.id } });
    expect(roomAfter.floorMapId).toBe(await mapId("lvcc-west-l2"));
    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.locationId).toBe(room.id);
  });

  it("excludes archived and already-pinned signs by default", async () => {
    const arch = await makeSign("APW301", { status: "archived" });
    const pinned = await makeSign("APW301", {
      mapX: 5,
      mapY: 5,
      mapFloor: "lvcc-west-l3",
    });
    const res = await applyAutoPin(RULES, {});
    // No eligible (unplaced) sign → nothing created or linked.
    expect(res.created).toBe(0);
    expect(res.linked).toBe(0);

    expect(
      (await prisma.sign.findUniqueOrThrow({ where: { id: arch.id } })).locationId,
    ).toBeNull();
    const pinnedAfter = await prisma.sign.findUniqueOrThrow({ where: { id: pinned.id } });
    expect(pinnedAfter.mapX).toBe(5); // hand placement preserved
    expect(pinnedAfter.locationId).toBeNull();
  });

  it("overwrite ON re-pins an already-placed sign to its room", async () => {
    const pinned = await makeSign("APW301", {
      mapX: 5,
      mapY: 5,
      mapFloor: "lvcc-west-l3",
    });
    const res = await applyAutoPin(RULES, { includeOverwrite: true });
    expect(res.created).toBe(1);
    const room = await prisma.location.findUniqueOrThrow({
      where: { locationCode: "APW301" },
    });
    const after = await prisma.sign.findUniqueOrThrow({ where: { id: pinned.id } });
    expect(after.locationId).toBe(room.id);
    expect(after.mapX).toBeNull(); // override cleared so the room pin resolves
  });

  it("is idempotent — a re-run creates no duplicate room and re-links nothing", async () => {
    await makeSign("APW301");
    const first = await applyAutoPin(RULES, {});
    expect(first.created).toBe(1);
    expect(first.linked).toBe(1);

    const second = await applyAutoPin(RULES, {});
    expect(second.created).toBe(0);
    expect(second.linked).toBe(0);
    expect(await prisma.location.count({ where: { locationCode: "APW301" } })).toBe(1);
  });

  it("never creates a range room; leaves range signs unlinked", async () => {
    const sign = await makeSign("APW201-APW202");
    const res = await applyAutoPin(RULES, {});
    expect(res.created).toBe(0);
    expect(
      await prisma.location.findFirst({ where: { locationCode: "APW201-APW202" } }),
    ).toBeNull();
    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.locationId).toBeNull();
  });

  it("records a reversible audit row", async () => {
    await makeSign("APW301");
    await applyAutoPin(RULES, {});
    const log = await prisma.auditLog.findFirst({
      where: { action: "sign.bulk_autopin" },
      orderBy: { id: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log?.detail).toMatch(/linked 1 sign/);
    expect(log?.detail).toMatch(/linkedSignIds/);
  });

  it("refuses a non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
    } as never);
    await expect(applyAutoPin(RULES, {})).rejects.toThrow(/role 'admin'/);
  });

  it("rejects rules pointing at an unknown floor map", async () => {
    await makeSign("APW301");
    await expect(
      applyAutoPin(
        [{ match: "prefix", value: "APW3", floorMapKey: "nonexistent-map" }],
        {},
      ),
    ).rejects.toThrow(/unknown-floor-map-key/);
    // Nothing written.
    expect(await prisma.location.count({ where: { locationCode: "APW301" } })).toBe(0);
  });
});

describe("previewAutoPin", () => {
  it("buckets signs without writing anything", async () => {
    await makeSign("APW301"); // create+link
    await makeSign("APW201-APW202"); // range
    await makeSign(null); // unmatched blank

    const preview = await previewAutoPin(RULES);
    expect(preview.plan.counts.create).toBe(1);
    expect(preview.plan.counts.range).toBe(1);
    expect(preview.plan.counts.unmatched).toBe(1);
    expect(preview.enabledMaps.map((m) => m.key)).toContain("lvcc-west-l3");
    expect(preview.invalidRuleKeys).toEqual([]);

    // No writes on preview.
    expect(await prisma.location.count({ where: { locationCode: "APW301" } })).toBe(0);
  });
});
