import { describe, it, expect } from "vitest";

import {
  buildFloorResolver,
  resolveSignPin,
  type SignPinInput,
} from "@/lib/sign-pin";

// The stable LVCC levels, as the DB loader would supply them (ordered). Halls /
// North Hall have no map row, so they resolve to null — same behavior as before,
// now data-driven instead of a hardcoded registry.
const FLOORS = buildFloorResolver([
  { key: "lvcc-west-l1", zoneCode: "LVCC-L1" },
  { key: "lvcc-west-l2", zoneCode: "LVCC-L2" },
  { key: "lvcc-west-l3", zoneCode: "LVCC-L3" },
]);

describe("buildFloorResolver", () => {
  it("maps the stable LVCC levels to floor keys", () => {
    expect(FLOORS.floorKeyForZone("LVCC-L1")).toBe("lvcc-west-l1");
    expect(FLOORS.floorKeyForZone("LVCC-L2")).toBe("lvcc-west-l2");
    expect(FLOORS.floorKeyForZone("LVCC-L3")).toBe("lvcc-west-l3");
  });

  it("returns null for zones with no map (halls, North Hall) and unknowns", () => {
    expect(FLOORS.floorKeyForZone("LVCC-H1")).toBeNull();
    expect(FLOORS.floorKeyForZone("LVCC-NH")).toBeNull();
    expect(FLOORS.floorKeyForZone("WHATEVER")).toBeNull();
    expect(FLOORS.floorKeyForZone(null)).toBeNull();
  });

  it("validates floor keys against the loaded set", () => {
    expect(FLOORS.isValidFloorKey("lvcc-west-l1")).toBe(true);
    expect(FLOORS.isValidFloorKey("nope")).toBe(false);
    expect(FLOORS.isValidFloorKey(null)).toBe(false);
  });

  it("lets the first map listed win as a zone's default floor", () => {
    const r = buildFloorResolver([
      { key: "a", zoneCode: "LVCC-L1" },
      { key: "b", zoneCode: "LVCC-L1" },
    ]);
    expect(r.floorKeyForZone("LVCC-L1")).toBe("a");
  });
});

describe("resolveSignPin (hybrid precedence)", () => {
  const base: SignPinInput = {
    mapX: null,
    mapY: null,
    mapFloor: null,
    zone: { zoneCode: "LVCC-L2" },
    location: null,
  };

  it("uses the sign's own override pin first", () => {
    const pin = resolveSignPin(
      { ...base, mapX: 40, mapY: 55, mapFloor: "lvcc-west-l2" },
      FLOORS,
    );
    expect(pin).toEqual({ floorKey: "lvcc-west-l2", xPct: 40, yPct: 55, source: "override" });
  });

  it("derives the override floor from the sign's zone when mapFloor is unset", () => {
    const pin = resolveSignPin({ ...base, mapX: 10, mapY: 20, mapFloor: null }, FLOORS);
    expect(pin?.floorKey).toBe("lvcc-west-l2");
    expect(pin?.source).toBe("override");
  });

  it("ignores an unknown mapFloor and falls back to the zone default", () => {
    const pin = resolveSignPin(
      { ...base, mapX: 10, mapY: 20, mapFloor: "deleted-floor" },
      FLOORS,
    );
    expect(pin?.floorKey).toBe("lvcc-west-l2");
  });

  it("falls back to the registry room pin when the sign has no override", () => {
    const pin = resolveSignPin(
      { ...base, location: { mapX: 70, mapY: 30, zone: { zoneCode: "LVCC-L3" } } },
      FLOORS,
    );
    expect(pin).toEqual({ floorKey: "lvcc-west-l3", xPct: 70, yPct: 30, source: "room" });
  });

  it("prefers the room's attached floor map over zone derivation", () => {
    const pin = resolveSignPin(
      {
        ...base,
        location: {
          mapX: 70,
          mapY: 30,
          zone: { zoneCode: "LVCC-L1" },
          floorMap: { key: "lvcc-west-l3" },
        },
      },
      FLOORS,
    );
    expect(pin?.floorKey).toBe("lvcc-west-l3"); // map wins over the zone (L1)
    expect(pin?.source).toBe("room");
  });

  it("falls back to zone when the room's floor map key is unknown/disabled", () => {
    const pin = resolveSignPin(
      {
        ...base,
        location: {
          mapX: 70,
          mapY: 30,
          zone: { zoneCode: "LVCC-L3" },
          floorMap: { key: "deleted-floor" },
        },
      },
      FLOORS,
    );
    expect(pin?.floorKey).toBe("lvcc-west-l3");
  });

  it("override wins over the room pin", () => {
    const pin = resolveSignPin(
      {
        ...base,
        mapX: 5,
        mapY: 5,
        location: { mapX: 70, mapY: 30, zone: { zoneCode: "LVCC-L3" } },
      },
      FLOORS,
    );
    expect(pin?.source).toBe("override");
    expect(pin?.xPct).toBe(5);
  });

  it("is unplaced when there's no override and no room pin", () => {
    expect(resolveSignPin(base, FLOORS)).toBeNull();
    expect(
      resolveSignPin({ ...base, location: { mapX: null, mapY: null } }, FLOORS),
    ).toBeNull();
  });

  it("rejects out-of-range coordinates (treats them as unplaced)", () => {
    expect(resolveSignPin({ ...base, mapX: 120, mapY: 50 }, FLOORS)).toBeNull();
    expect(resolveSignPin({ ...base, mapX: -1, mapY: 50 }, FLOORS)).toBeNull();
  });

  it("is unplaced when the pin is on a zone with no map yet (a hall)", () => {
    const pin = resolveSignPin(
      {
        mapX: 40,
        mapY: 40,
        mapFloor: null,
        zone: { zoneCode: "LVCC-H1" },
        location: null,
      },
      FLOORS,
    );
    expect(pin).toBeNull();
  });
});
