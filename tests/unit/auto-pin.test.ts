import { describe, it, expect } from "vitest";

import {
  buildFloorMapResolver,
  classifyAutoPin,
  type AutoPinRoom,
  type AutoPinSign,
} from "@/lib/auto-pin";

// A representative prefix→map table for the 3 LVCC levels: W2xx→L2, W3xx→L3,
// N2xx→L2 (North Hall folded onto L2), numeric booths→L1.
const RESOLVE = buildFloorMapResolver([
  { match: "prefix", value: "W2", floorMapKey: "lvcc-west-l2" },
  { match: "prefix", value: "W3", floorMapKey: "lvcc-west-l3" },
  { match: "prefix", value: "N2", floorMapKey: "lvcc-west-l2" },
  { match: "numeric", floorMapKey: "lvcc-west-l1" },
]);

const sign = (
  id: number,
  exactDestination: string | null,
  over: Partial<AutoPinSign> = {},
): AutoPinSign => ({
  id,
  exactDestination,
  locationId: null,
  mapX: null,
  mapY: null,
  ...over,
});

const room = (
  id: number,
  locationCode: string,
  floorMapId: number | null = null,
): AutoPinRoom => ({ id, locationCode, floorMapId });

describe("buildFloorMapResolver", () => {
  it("matches by prefix and by leading digit, first rule wins", () => {
    expect(RESOLVE("W204")).toBe("lvcc-west-l2");
    expect(RESOLVE("W301")).toBe("lvcc-west-l3");
    expect(RESOLVE("N230")).toBe("lvcc-west-l2");
    expect(RESOLVE("1400")).toBe("lvcc-west-l1");
  });

  it("returns null when no rule matches", () => {
    expect(RESOLVE("HALLWAY")).toBeNull();
    expect(RESOLVE("CONTEST")).toBeNull();
  });

  it("honours rule order (first match wins)", () => {
    const r = buildFloorMapResolver([
      { match: "prefix", value: "W", floorMapKey: "catch-all" },
      { match: "prefix", value: "W2", floorMapKey: "specific" },
    ]);
    expect(r("W204")).toBe("catch-all");
  });

  it("upper-cases prefix values so a lowercase rule still matches", () => {
    const r = buildFloorMapResolver([
      { match: "prefix", value: "w2", floorMapKey: "lvcc-west-l2" },
    ]);
    expect(r("W204")).toBe("lvcc-west-l2");
  });
});

describe("classifyAutoPin", () => {
  it("links a sign to an existing placed room (not orphaned, no re-home)", () => {
    const plan = classifyAutoPin(
      [sign(1, "W204")],
      [room(10, "W204", 2 /* floorMapId */)],
      RESOLVE,
    );
    expect(plan.links).toEqual([
      { code: "W204", roomId: 10, roomOrphaned: false, floorMapKey: null, signIds: [1] },
    ]);
    expect(plan.rehome).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.counts.link).toBe(1);
    expect(plan.counts.distinctRoomsToPlace).toBe(1);
  });

  it("links to an orphaned room and schedules a re-home when the code resolves", () => {
    const plan = classifyAutoPin(
      [sign(1, "W204")],
      [room(10, "W204", null /* orphaned */)],
      RESOLVE,
    );
    expect(plan.links[0]).toMatchObject({
      roomId: 10,
      roomOrphaned: true,
      floorMapKey: "lvcc-west-l2",
    });
    expect(plan.rehome).toEqual([{ roomId: 10, floorMapKey: "lvcc-west-l2" }]);
    expect(plan.counts.orphanRoomsToRehome).toBe(1);
  });

  it("links to an orphaned room but does NOT re-home when the code is unresolvable", () => {
    const plan = classifyAutoPin(
      [sign(1, "CONTESTROOM")],
      [room(10, "CONTESTROOM", null)],
      RESOLVE,
    );
    expect(plan.links[0]).toMatchObject({ roomOrphaned: true, floorMapKey: null });
    expect(plan.rehome).toEqual([]);
  });

  it("creates + links a new room when no room exists and the code resolves to a map", () => {
    const plan = classifyAutoPin([sign(1, "W301")], [], RESOLVE);
    expect(plan.creates).toEqual([
      { code: "W301", floorMapKey: "lvcc-west-l3", signIds: [1] },
    ]);
    expect(plan.links).toEqual([]);
    expect(plan.counts.create).toBe(1);
  });

  it("uses the normalized (upper-cased) code as the room code to create", () => {
    const plan = classifyAutoPin([sign(1, "w204")], [], RESOLVE);
    expect(plan.creates[0].code).toBe("W204");
  });

  it("buckets an unmatched single code (no room, no map rule) as no-map", () => {
    const plan = classifyAutoPin([sign(1, "HALLWAY")], [], RESOLVE);
    expect(plan.unmatched).toEqual([
      { code: "HALLWAY", reason: "no-map", signIds: [1] },
    ]);
    expect(plan.creates).toEqual([]);
  });

  it("buckets a range/multi-room code separately and never creates it", () => {
    // numeric-leading so the resolver WOULD map it to L1 — range must win.
    const plan = classifyAutoPin([sign(1, "1400-1402")], [], RESOLVE);
    expect(plan.ranges).toEqual([{ code: "1400-1402", signIds: [1] }]);
    expect(plan.creates).toEqual([]);
    expect(plan.counts.range).toBe(1);
  });

  it("links a range code when it exists verbatim as a room (existing beats range)", () => {
    const plan = classifyAutoPin(
      [sign(1, "1400-1402")],
      [room(10, "1400-1402", 1)],
      RESOLVE,
    );
    expect(plan.links[0]).toMatchObject({ roomId: 10 });
    expect(plan.ranges).toEqual([]);
  });

  it("groups blank / whitespace destinations into one unmatched(blank) bucket", () => {
    const plan = classifyAutoPin(
      [sign(1, null), sign(2, "   "), sign(3, "")],
      [],
      RESOLVE,
    );
    expect(plan.unmatched).toEqual([
      { code: null, reason: "blank", signIds: [1, 2, 3] },
    ]);
  });

  it("collapses separator-only spelling variants into one group", () => {
    // "W204, W205" and "W204-W205" both normalize to "W204-W205".
    const plan = classifyAutoPin(
      [sign(1, "W204, W205"), sign(2, "W204-W205")],
      [],
      RESOLVE,
    );
    expect(plan.ranges).toEqual([{ code: "W204-W205", signIds: [1, 2] }]);
  });

  it("matches an existing room across a spelling variant", () => {
    const plan = classifyAutoPin(
      [sign(1, "W204, W205")],
      [room(10, "W204-W205", 2)],
      RESOLVE,
    );
    expect(plan.links[0]).toMatchObject({ code: "W204-W205", roomId: 10 });
  });

  it("excludes already-linked signs into the opt-in overwrite bucket", () => {
    const plan = classifyAutoPin(
      [sign(1, "W204", { locationId: 99 })],
      [room(10, "W204", 2)],
      RESOLVE,
    );
    expect(plan.overwrite).toEqual([{ code: "W204", signIds: [1] }]);
    expect(plan.links).toEqual([]);
    expect(plan.counts.overwrite).toBe(1);
  });

  it("excludes already-pinned (override) signs into the overwrite bucket", () => {
    const plan = classifyAutoPin(
      [sign(1, "W204", { mapX: 10, mapY: 20 })],
      [],
      RESOLVE,
    );
    expect(plan.overwrite).toEqual([{ code: "W204", signIds: [1] }]);
    expect(plan.creates).toEqual([]);
  });

  it("computes a correct summary over a mixed batch", () => {
    const plan = classifyAutoPin(
      [
        sign(1, "W204"), // link (existing placed)
        sign(2, "W205"), // create+link (resolves L2)
        sign(3, "W205"), // create+link, same room as #2
        sign(4, "1400-1402"), // range
        sign(5, "HALLWAY"), // unmatched no-map
        sign(6, null), // unmatched blank
        sign(7, "W204", { mapX: 1, mapY: 1 }), // overwrite
      ],
      [room(10, "W204", 2)],
      RESOLVE,
    );
    expect(plan.counts).toEqual({
      signsConsidered: 7,
      link: 1,
      create: 2,
      range: 1,
      unmatched: 2,
      overwrite: 1,
      distinctRoomsToPlace: 2, // 1 link group + 1 create group
      orphanRoomsToRehome: 0,
    });
    // #2 and #3 share one create group.
    expect(plan.creates).toEqual([
      { code: "W205", floorMapKey: "lvcc-west-l2", signIds: [2, 3] },
    ]);
  });
});
