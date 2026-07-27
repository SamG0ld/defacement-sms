import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
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
// Every action here is per-actor rate limited (#194). Mock the limiter like the
// sibling action suites do, so the suite doesn't share one 60/min budget across
// its own tests if UPSTASH_* ever leaks into the test env.
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
import { buildFloorResolver, resolveSignPin } from "@/lib/sign-pin";
import {
  createFloorMap,
  createRoom,
  deleteFloorMap,
  reorderFloorMap,
  setRoomPin,
  setSignMapPin,
} from "@/app/(app)/map/actions";

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    user: { id: "admin1", email: "admin@example.com", isActive: true, role: "admin" },
  } as never);
});
afterEach(async () => {
  vi.clearAllMocks();
  // signs are truncated by global setup; locations are not.
  await prisma.location.deleteMany({ where: { locationCode: { startsWith: "TEST-" } } });
  // throwaway floor maps created by the deleteFloorMap tests (the seeded
  // lvcc-west-* maps other tests depend on are never touched).
  await prisma.floorMap.deleteMany({ where: { key: { startsWith: "test-del-" } } });
});

// Every action redirects (success → the page, failure → ?error=). Capture the
// URL so we can both detect failures and then assert DB state.
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { redirectUrl?: string }).redirectUrl;
    // Decode so assertions match the human message, not its URL-encoding
    // (encodeURIComponent → %20, URLSearchParams → +).
    if (url !== undefined) return decodeURIComponent(url.replace(/\+/g, " "));
    throw e;
  }
  throw new Error("expected a redirect");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const L1 = "lvcc-west-l1";
const L2 = "lvcc-west-l2";

async function l2ZoneId(): Promise<number> {
  const z = await prisma.zone.findUniqueOrThrow({ where: { zoneCode: "LVCC-L2" } });
  return z.id;
}
async function floorMapIdOf(key: string): Promise<number> {
  const m = await prisma.floorMap.findUniqueOrThrow({ where: { key }, select: { id: true } });
  return m.id;
}
async function makeSign(zoneId: number) {
  return prisma.sign.create({
    data: { itemId: "TESTSIGN", signText: "T", signType: "Sign", size: "22x28", zoneId },
  });
}

describe("createRoom", () => {
  it("adds a room to the floor's zone and audits it", async () => {
    const url = await redirectOf(createRoom(form({ floor: L2, code: "TEST-229" })));
    expect(url).not.toMatch(/error=/);
    const room = await prisma.location.findUnique({ where: { locationCode: "TEST-229" } });
    expect(room?.zoneId).toBe(await l2ZoneId());
    // Rooms now attach to the floor map directly.
    const l2Map = await prisma.floorMap.findUnique({ where: { key: L2 }, select: { id: true } });
    expect(room?.floorMapId).toBe(l2Map?.id);
    expect(await prisma.auditLog.findFirst({ where: { action: "room.add" } })).not.toBeNull();
  });

  it("rejects a bad floor", async () => {
    const url = await redirectOf(createRoom(form({ floor: "nope", code: "TEST-1" })));
    expect(url).toMatch(/valid floor/i);
  });
});

describe("setRoomPin", () => {
  it("stores the room's coordinates", async () => {
    const zoneId = await l2ZoneId();
    const room = await prisma.location.create({
      data: { locationCode: "TEST-230", building: "LVCC West", floor: "2", zoneId },
    });
    await redirectOf(setRoomPin(room.id, form({ floor: L2, x: "62.5", y: "40" })));
    const after = await prisma.location.findUnique({ where: { id: room.id } });
    expect(after?.mapX).toBe(62.5);
    expect(after?.mapY).toBe(40);
  });

  it("rejects out-of-range coordinates", async () => {
    const zoneId = await l2ZoneId();
    const room = await prisma.location.create({
      data: { locationCode: "TEST-231", building: "LVCC West", floor: "2", zoneId },
    });
    const url = await redirectOf(setRoomPin(room.id, form({ floor: L2, x: "150", y: "40" })));
    expect(url).toMatch(/position/i);
  });
});

describe("setSignMapPin", () => {
  it("override: sets the sign's own pin and clears any stale room link", async () => {
    const zoneId = await l2ZoneId();
    const room = await prisma.location.create({
      data: { locationCode: "TEST-ovr", building: "LVCC West", floor: "2", zoneId, mapX: 5, mapY: 5 },
    });
    const sign = await prisma.sign.create({
      data: { itemId: "TSO", signText: "T", signType: "Sign", size: "22x28", zoneId, locationId: room.id },
    });
    await redirectOf(setSignMapPin(sign.id, form({ mode: "override", x: "10", y: "20", floor: L2 })));
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after).toMatchObject({ mapX: 10, mapY: 20, mapFloor: L2 });
    expect(after?.locationId).toBeNull(); // override clears the room link
  });

  it("override: rejects an unknown floor key", async () => {
    const zoneId = await l2ZoneId();
    const sign = await makeSign(zoneId);
    const url = await redirectOf(
      setSignMapPin(sign.id, form({ mode: "override", x: "10", y: "20", floor: "bogus" })),
    );
    expect(url).toMatch(/floor map no longer exists/i);
  });

  it("room: links the sign and clears any override", async () => {
    const zoneId = await l2ZoneId();
    const room = await prisma.location.create({
      data: { locationCode: "TEST-232", building: "LVCC West", floor: "2", zoneId, mapX: 50, mapY: 50 },
    });
    const sign = await prisma.sign.create({
      data: { itemId: "TS2", signText: "T", signType: "Sign", size: "22x28", zoneId, mapX: 1, mapY: 2, mapFloor: L2 },
    });
    await redirectOf(setSignMapPin(sign.id, form({ mode: "room", locationId: String(room.id) })));
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after?.locationId).toBe(room.id);
    expect(after?.mapX).toBeNull(); // override cleared so the room pin resolves
  });

  // #181: the room <select> in WhereItGoes only lists rooms on the sign's own
  // floor, but the action is directly callable with any (signId, locationId) —
  // and resolveSignPin then renders the sign on the ROOM's map, silently sending
  // crews to the wrong floor. The server has to enforce what the UI implies.
  it("room: refuses a room that sits on a different floor map", async () => {
    const zoneId = await l2ZoneId(); // sign resolves to lvcc-west-l2
    const room = await prisma.location.create({
      data: {
        locationCode: "TEST-otherfloor",
        building: "LVCC West",
        floor: "1",
        floorMapId: await floorMapIdOf(L1),
        mapX: 50,
        mapY: 50,
      },
    });
    const sign = await makeSign(zoneId);

    const url = await redirectOf(
      setSignMapPin(sign.id, form({ mode: "room", locationId: String(room.id) })),
    );
    expect(url).toMatch(/different floor/i);
    // Nothing persisted — the sign is still unlinked.
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after?.locationId).toBeNull();
  });

  it("room: allows a room attached to the sign's own floor map", async () => {
    const zoneId = await l2ZoneId();
    const room = await prisma.location.create({
      data: {
        locationCode: "TEST-samefloor",
        building: "LVCC West",
        floor: "2",
        zoneId,
        floorMapId: await floorMapIdOf(L2),
        mapX: 50,
        mapY: 50,
      },
    });
    const sign = await makeSign(zoneId);
    await redirectOf(setSignMapPin(sign.id, form({ mode: "room", locationId: String(room.id) })));
    expect((await prisma.sign.findUnique({ where: { id: sign.id } }))?.locationId).toBe(room.id);
  });

  it("room: lets a sign stranded on the wrong floor be relinked to its zone's floor", async () => {
    // The repair case: an override pin (or an older bad link) has this L2 sign
    // resolving on L1, so a resolved-floor-only check would refuse the correct
    // L2 room and leave the mistake stuck. The zone floor counts as its own too.
    const zoneId = await l2ZoneId();
    const sign = await prisma.sign.create({
      data: {
        itemId: "TSSTRAND", signText: "T", signType: "Sign", size: "22x28",
        zoneId, mapX: 10, mapY: 10, mapFloor: L1,
      },
    });
    const room = await prisma.location.create({
      data: {
        locationCode: "TEST-repair",
        building: "LVCC West",
        floor: "2",
        zoneId,
        floorMapId: await floorMapIdOf(L2),
        mapX: 30,
        mapY: 30,
      },
    });

    await redirectOf(setSignMapPin(sign.id, form({ mode: "room", locationId: String(room.id) })));
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after?.locationId).toBe(room.id);
    expect(after?.mapFloor).toBeNull(); // the stale override is cleared
  });

  it("room: still links a sign with no floor context at all", async () => {
    // No zone and no pin → the sign has no floor to contradict, so any room is
    // as good as any other (and the room's own map is what will resolve).
    const sign = await prisma.sign.create({
      data: { itemId: "TSNOZONE", signText: "T", signType: "Sign", size: "22x28" },
    });
    const room = await prisma.location.create({
      data: {
        locationCode: "TEST-nozone",
        building: "LVCC West",
        floorMapId: await floorMapIdOf(L1),
        mapX: 10,
        mapY: 10,
      },
    });
    await redirectOf(setSignMapPin(sign.id, form({ mode: "room", locationId: String(room.id) })));
    expect((await prisma.sign.findUnique({ where: { id: sign.id } }))?.locationId).toBe(room.id);
  });

  it("clear: removes pin and room link", async () => {
    const zoneId = await l2ZoneId();
    const sign = await prisma.sign.create({
      data: { itemId: "TS3", signText: "T", signType: "Sign", size: "22x28", zoneId, mapX: 5, mapY: 5, mapFloor: L2 },
    });
    await redirectOf(setSignMapPin(sign.id, form({ mode: "clear" })));
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after).toMatchObject({ mapX: null, mapY: null, mapFloor: null, locationId: null });
  });
});

// A 24-byte PNG: the 8-byte signature plus an IHDR whose width/height are all
// validateImageUpload reads (lib/image-upload.ts pngDimensions).
function pngBytes() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // length 13 + "IHDR"
    0x00, 0x00, 0x00, 0x01, // width 1
    0x00, 0x00, 0x00, 0x01, // height 1
  ]);
}

function uploadForm(label: string): FormData {
  const fd = new FormData();
  fd.set("label", label);
  fd.set("image", new File([pngBytes()], "floor.png", { type: "image/png" }));
  return fd;
}

// #194: these actions were the mutation surface with no per-actor backstop —
// most notably repeated 10 MB floor-image uploads into a bytea column.
describe("per-actor mutation rate limit", () => {
  const OVER_BUDGET = { success: false, remaining: 0, reset: 0 };

  it("refuses a sign pin over budget, without writing", async () => {
    const zoneId = await l2ZoneId();
    const sign = await makeSign(zoneId);
    vi.mocked(checkMutationRateLimit).mockResolvedValueOnce(OVER_BUDGET);

    const url = await redirectOf(
      setSignMapPin(sign.id, form({ mode: "override", x: "10", y: "20", floor: L2 })),
    );
    expect(url).toMatch(/too many changes/i);
    expect((await prisma.sign.findUnique({ where: { id: sign.id } }))?.mapX).toBeNull();
  });

  it("refuses a room create over budget, without writing", async () => {
    vi.mocked(checkMutationRateLimit).mockResolvedValueOnce(OVER_BUDGET);
    const url = await redirectOf(createRoom(form({ floor: L2, code: "TEST-throttled" })));
    expect(url).toMatch(/too many changes/i);
    expect(
      await prisma.location.findUnique({ where: { locationCode: "TEST-throttled" } }),
    ).toBeNull();
  });
});

describe("createFloorMap", () => {
  // #196: sortOrder was a non-atomic max+1, so two simultaneous uploads could
  // tie and leave the floor tabs in an arbitrary, non-self-healing order. The
  // read+write now runs inside one transaction holding an advisory lock — this
  // exercises that raw statement end-to-end (a bad cast would fail here) and
  // asserts two CONCURRENT creates still come out with distinct orders.
  it("assigns distinct sortOrders to two concurrent uploads", async () => {
    const before = await prisma.floorMap.aggregate({ _max: { sortOrder: true } });
    const max = before._max.sortOrder ?? 0;

    await Promise.allSettled([
      createFloorMap(uploadForm("Test Del Race A")),
      createFloorMap(uploadForm("Test Del Race B")),
    ]);

    const created = await prisma.floorMap.findMany({
      where: { key: { startsWith: "test-del-race-" } },
      select: { key: true, sortOrder: true, width: true, height: true },
      orderBy: { sortOrder: "asc" },
    });
    expect(created).toHaveLength(2);
    expect(created[0].sortOrder).not.toBe(created[1].sortOrder);
    expect(created.map((m) => m.sortOrder)).toEqual([max + 1, max + 2]);
    // The sniffed dimensions still land on the row (the create moved into the tx).
    expect(created[0]).toMatchObject({ width: 1, height: 1 });
  });

  it("audits the create and rejects a duplicate key", async () => {
    await redirectOf(createFloorMap(uploadForm("Test Del Dup")));
    expect(
      await prisma.auditLog.findFirst({ where: { action: "floormap.create" } }),
    ).not.toBeNull();

    const url = await redirectOf(createFloorMap(uploadForm("Test Del Dup")));
    expect(url).toMatch(/already exists/i);
  });
});

describe("reorderFloorMap", () => {
  // #195: reordering was the one structural floor-map action with no audit row,
  // so an unexplained tab order had no trail to follow.
  it("swaps sortOrder with the neighbour and audits it", async () => {
    const mk = (key: string, sortOrder: number) =>
      prisma.floorMap.create({
        data: {
          key,
          label: `Test ${key}`,
          imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          contentType: "image/png",
          sortOrder,
        },
      });
    const first = await mk("test-del-order-a", 900);
    const second = await mk("test-del-order-b", 901);

    await redirectOf(reorderFloorMap(form({ id: String(second.id), dir: "up" })));

    expect((await prisma.floorMap.findUniqueOrThrow({ where: { id: second.id } })).sortOrder).toBe(900);
    expect((await prisma.floorMap.findUniqueOrThrow({ where: { id: first.id } })).sortOrder).toBe(901);

    const log = await prisma.auditLog.findFirst({
      where: { action: "floormap.reorder" },
      orderBy: { id: "desc" },
    });
    expect(log?.detail).toContain("test-del-order-b");
    expect(log?.detail).toContain("test-del-order-a");
  });
});

describe("deleteFloorMap", () => {
  // A minimal throwaway floor map (key prefixed test-del- so afterEach reaps it).
  async function makeFloor(key: string) {
    return prisma.floorMap.create({
      data: {
        key,
        label: `Test ${key}`,
        imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        sortOrder: 999,
      },
    });
  }

  it("deletes the map, detaches its rooms (SetNull), leaves signs, and audits the blast radius", async () => {
    const key = "test-del-floor";
    const fm = await makeFloor(key);
    const zoneId = await l2ZoneId();
    // A room attached to this map, and a sign whose override pins this floor key.
    const room = await prisma.location.create({
      data: { locationCode: "TEST-DELROOM", building: "LVCC West", floor: "2", zoneId, floorMapId: fm.id },
    });
    const sign = await prisma.sign.create({
      data: { itemId: "TDEL", signText: "T", signType: "Sign", size: "22x28", zoneId, mapX: 10, mapY: 20, mapFloor: key },
    });

    const url = await redirectOf(deleteFloorMap(form({ id: String(fm.id) })));
    expect(url).not.toMatch(/error=/);

    // Map row gone.
    expect(await prisma.floorMap.findUnique({ where: { id: fm.id } })).toBeNull();
    // Room survives but detached (onDelete: SetNull).
    const roomAfter = await prisma.location.findUnique({ where: { id: room.id } });
    expect(roomAfter).not.toBeNull();
    expect(roomAfter?.floorMapId).toBeNull();
    // Sign survives, but its override pin is CLEARED (not left dangling): mapX/
    // mapY/mapFloor all null so it resolves to unplaced.
    const signAfter = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(signAfter).not.toBeNull();
    expect(signAfter?.mapX).toBeNull();
    expect(signAfter?.mapY).toBeNull();
    expect(signAfter?.mapFloor).toBeNull();
    // Audit records the blast radius.
    const log = await prisma.auditLog.findFirst({
      where: { action: "floormap.delete" },
      orderBy: { id: "desc" },
    });
    expect(log?.detail).toMatch(/1 room\(s\) detached/);
    expect(log?.detail).toMatch(/1 sign pin\(s\) cleared/);
  });

  it("clears an override pin instead of relocating it onto the zone's other map", async () => {
    const zoneId = await l2ZoneId();
    // A throwaway map the sign is explicitly pinned to — distinct from the zone's
    // seeded default (lvcc-west-l2), which is the map a naive delete would relocate
    // the stale pin onto.
    const target = await prisma.floorMap.create({
      data: {
        key: "test-del-target",
        label: "Test target",
        imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        sortOrder: 999,
        zoneId,
      },
    });
    const sign = await prisma.sign.create({
      data: {
        itemId: "TDELREL", signText: "T", signType: "Sign", size: "22x28",
        zoneId, mapX: 30, mapY: 40, mapFloor: "test-del-target",
      },
    });

    await redirectOf(deleteFloorMap(form({ id: String(target.id) })));

    const after = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });
    expect(after.mapX).toBeNull();
    expect(after.mapFloor).toBeNull();
    // End-to-end: even though the sign's zone still HAS a default map, the cleared
    // pin resolves to unplaced (null) — not relocated onto that map at 30,40. If
    // the pin-clearing were reverted, resolveSignPin would fall the stale coords
    // back onto lvcc-west-l2 and return non-null, failing this assertion.
    const resolver = buildFloorResolver([{ key: "lvcc-west-l2", zoneCode: "LVCC-L2" }]);
    expect(
      resolveSignPin(
        { mapX: after.mapX, mapY: after.mapY, mapFloor: after.mapFloor, zone: { zoneCode: "LVCC-L2" } },
        resolver,
      ),
    ).toBeNull();
  });

  it("rejects a missing floor map", async () => {
    const url = await redirectOf(deleteFloorMap(form({ id: "99999999" })));
    expect(url).toMatch(/not found/i);
  });

  it("refuses a non-admin (lead)", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
    } as never);
    const fm = await makeFloor("test-del-authz");
    await expect(deleteFloorMap(form({ id: String(fm.id) }))).rejects.toThrow(/role 'admin'/);
    // Still present — the delete was refused before touching the DB.
    expect(await prisma.floorMap.findUnique({ where: { id: fm.id } })).not.toBeNull();
  });
});
