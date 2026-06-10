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

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createRoom,
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

const L2 = "lvcc-west-l2";

async function l2ZoneId(): Promise<number> {
  const z = await prisma.zone.findUniqueOrThrow({ where: { zoneCode: "LVCC-L2" } });
  return z.id;
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
