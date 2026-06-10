// Resolve where a sign's pin goes on a venue floor map. The hybrid model:
//   1. the sign's own override pin (mapX/mapY/mapFloor) — for villages, halls,
//      one-offs, anything that doesn't follow the stable room layout;
//   2. else its registry room's pin (location.mapX/mapY) — the reusable, stable
//      LVCC room coordinates that persist year over year;
//   3. else unplaced (null) — surfaced as "needs placement".
//
// Pure function of already-loaded data so it's unit-testable and shared by the
// sign-detail view and the floor overview map. Floor maps are now data-driven
// (DB-backed, see lib/floor-maps.ts): rather than import the registry, the caller
// passes a FloorResolver built from the loaded maps. That keeps this module free
// of any DB/Prisma import so it stays synchronous and trivially testable.

export type ZoneRef = { zoneCode: string } | null | undefined;

export type SignPinInput = {
  mapX: number | null;
  mapY: number | null;
  mapFloor: string | null;
  zone?: ZoneRef;
  location?: {
    mapX: number | null;
    mapY: number | null;
    zone?: ZoneRef;
    // The room's own floor map (Location.floorMapId), if attached. Preferred
    // over zone-derivation so a room renders on the exact map it belongs to.
    floorMap?: { key: string } | null;
  } | null;
};

export type ResolvedPin = {
  floorKey: string;
  xPct: number;
  yPct: number;
  source: "override" | "room";
};

// The floor context resolveSignPin needs, supplied by the caller from the loaded
// floor maps (see buildFloorResolver). Injecting it keeps this file DB-free.
export type FloorResolver = {
  // Is this a key of a known, enabled floor map?
  isValidFloorKey: (key: string | null | undefined) => boolean;
  // The default floor for a zone (the map whose zone matches), or null.
  floorKeyForZone: (zoneCode: string | null | undefined) => string | null;
};

// The minimal floor-map shape buildFloorResolver derives from. The DB loader
// produces these; tests can construct them directly.
export type FloorMapMeta = {
  key: string;
  zoneCode: string | null;
};

// Build a (pure, synchronous) resolver from the loaded floor maps. The first map
// listed for a given zone wins as that zone's default (callers pass maps already
// ordered by sortOrder).
export function buildFloorResolver(maps: FloorMapMeta[]): FloorResolver {
  const keys = new Set(maps.map((m) => m.key));
  const zoneToKey = new Map<string, string>();
  for (const m of maps) {
    if (m.zoneCode && !zoneToKey.has(m.zoneCode)) zoneToKey.set(m.zoneCode, m.key);
  }
  return {
    isValidFloorKey: (key) => !!key && keys.has(key),
    floorKeyForZone: (zoneCode) => (zoneCode ? (zoneToKey.get(zoneCode) ?? null) : null),
  };
}

// A pin is only usable with both coordinates present and in the 0–100 range
// (they're percentages of the floor image).
function validCoords(x: number | null, y: number | null): boolean {
  return (
    x !== null &&
    y !== null &&
    x >= 0 &&
    x <= 100 &&
    y >= 0 &&
    y <= 100
  );
}

export function resolveSignPin(
  sign: SignPinInput,
  floors: FloorResolver,
): ResolvedPin | null {
  // 1. Override pin on the sign itself wins.
  if (validCoords(sign.mapX, sign.mapY)) {
    // Prefer the explicitly-stored floor; fall back to the sign's zone.
    const floorKey = floors.isValidFloorKey(sign.mapFloor)
      ? sign.mapFloor
      : floors.floorKeyForZone(sign.zone?.zoneCode);
    if (floorKey) {
      return {
        floorKey,
        xPct: sign.mapX as number,
        yPct: sign.mapY as number,
        source: "override",
      };
    }
  }

  // 2. Registry room pin (the reusable, stable coordinates).
  const loc = sign.location;
  if (loc && validCoords(loc.mapX, loc.mapY)) {
    // Prefer the room's attached floor map; fall back to deriving from the
    // room's (or the sign's) zone for rooms not yet linked to a map.
    const floorKey =
      loc.floorMap && floors.isValidFloorKey(loc.floorMap.key)
        ? loc.floorMap.key
        : floors.floorKeyForZone(loc.zone?.zoneCode ?? sign.zone?.zoneCode);
    if (floorKey) {
      return {
        floorKey,
        xPct: loc.mapX as number,
        yPct: loc.mapY as number,
        source: "room",
      };
    }
  }

  // 3. Unplaced.
  return null;
}
