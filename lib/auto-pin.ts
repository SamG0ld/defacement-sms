// Pure, DB-free classifier for the bulk "auto-pin by room code" tool. Buckets
// each sign by its normalized room code against the existing room registry, and
// assigns a target floor map to rooms it would create or re-home via an injected
// resolver. The 3 DC34 maps aren't zone-linked, so a room's map identity comes
// from the room CODE (not the sign's zone) — see plans/bulk-pin-helper.md. Kept
// free of any Prisma import so it stays synchronous and trivially unit-testable,
// exactly like lib/sign-pin.ts.

import { normalizeRoomCode } from "@/lib/room-code";

// The minimal sign shape the classifier reads. The caller supplies these from a
// query that already excludes archived signs (status is not needed here).
export type AutoPinSign = {
  id: number;
  exactDestination: string | null;
  locationId: number | null;
  mapX: number | null;
  mapY: number | null;
};

// The minimal existing-room shape. `floorMapId === null` means the room is
// orphaned (not on any current map) and needs re-homing before its pin resolves.
export type AutoPinRoom = {
  id: number;
  locationCode: string;
  floorMapId: number | null;
};

// Resolve which floor map (by FloorMap.key) a normalized room code belongs to.
// Returns null when no rule matches — the code is then left unmatched rather than
// guessed onto a map.
export type FloorMapResolver = (normalizedCode: string) => string | null;

// Admin-editable rules that build a resolver: match a code by prefix (e.g. "W2")
// or by leading digit (numeric booths), first rule wins.
export type FloorMapRule =
  | { match: "prefix"; value: string; floorMapKey: string }
  | { match: "numeric"; floorMapKey: string };

export function buildFloorMapResolver(rules: FloorMapRule[]): FloorMapResolver {
  const prepared = rules.map((r) =>
    r.match === "prefix" ? { ...r, value: r.value.trim().toUpperCase() } : r,
  );
  return (code) => {
    for (const rule of prepared) {
      if (rule.match === "numeric") {
        if (/^\d/.test(code)) return rule.floorMapKey;
      } else if (rule.value && code.startsWith(rule.value)) {
        return rule.floorMapKey;
      }
    }
    return null;
  };
}

export type LinkGroup = {
  code: string;
  roomId: number;
  roomOrphaned: boolean; // existing room has no floorMapId yet
  floorMapKey: string | null; // where we'd re-home it, if orphaned + resolvable
  signIds: number[];
};
export type CreateGroup = { code: string; floorMapKey: string; signIds: number[] };
export type RangeGroup = { code: string; signIds: number[] };
export type UnmatchedGroup = {
  code: string | null;
  reason: "blank" | "no-map";
  signIds: number[];
};

export type AutoPinPlan = {
  links: LinkGroup[];
  creates: CreateGroup[];
  ranges: RangeGroup[];
  unmatched: UnmatchedGroup[];
  // Already-placed/linked signs that WOULD match — excluded from the write by
  // default; the wizard surfaces them as an opt-in "overwrite" bucket.
  overwrite: { code: string; signIds: number[] }[];
  // Distinct existing orphaned rooms to re-home (set floorMapId), deduped.
  rehome: { roomId: number; floorMapKey: string }[];
  counts: {
    signsConsidered: number;
    link: number;
    create: number;
    range: number;
    unmatched: number;
    overwrite: number;
    distinctRoomsToPlace: number; // links + creates = the O(rooms) manual number
    orphanRoomsToRehome: number;
  };
};

// A normalized code always has content; a leading NUL can't collide with one, so
// it's a safe grouping key for the blank-destination bucket.
const BLANK_KEY = "\x00blank";

// A hyphen survives normalization only between two tokens (separators collapse to
// one hyphen, edges are trimmed) — i.e. a range / multi-room string like
// "1400-1402" or "W204, W205". These can't map to a single Location.
function isRange(code: string): boolean {
  return code.includes("-");
}

function bucketPush<T extends { signIds: number[] }>(
  map: Map<string, T>,
  key: string,
  make: () => T,
  signId: number,
): void {
  let group = map.get(key);
  if (!group) {
    group = make();
    map.set(key, group);
  }
  group.signIds.push(signId);
}

export function classifyAutoPin(
  signs: AutoPinSign[],
  rooms: AutoPinRoom[],
  resolveFloorMapKey: FloorMapResolver,
): AutoPinPlan {
  // normalized locationCode -> room (first wins on a normalization collision).
  const roomByCode = new Map<string, AutoPinRoom>();
  for (const room of rooms) {
    const key = normalizeRoomCode(room.locationCode);
    if (key && !roomByCode.has(key)) roomByCode.set(key, room);
  }

  const links = new Map<string, LinkGroup>();
  const creates = new Map<string, CreateGroup>();
  const ranges = new Map<string, RangeGroup>();
  const unmatched = new Map<string, UnmatchedGroup>();
  const overwrite = new Map<string, { code: string; signIds: number[] }>();

  for (const sign of signs) {
    const code = normalizeRoomCode((sign.exactDestination ?? "").trim());
    if (!code) {
      bucketPush(
        unmatched,
        BLANK_KEY,
        () => ({ code: null, reason: "blank" as const, signIds: [] }),
        sign.id,
      );
      continue;
    }

    // Already pinned (override) or already linked → never auto-touched; if it
    // would otherwise match, surface it in the opt-in overwrite bucket.
    if (sign.locationId !== null || sign.mapX !== null || sign.mapY !== null) {
      bucketPush(overwrite, code, () => ({ code, signIds: [] }), sign.id);
      continue;
    }

    const existing = roomByCode.get(code);
    if (existing) {
      const orphaned = existing.floorMapId === null;
      const floorMapKey = orphaned ? resolveFloorMapKey(code) : null;
      bucketPush(
        links,
        code,
        () => ({
          code,
          roomId: existing.id,
          roomOrphaned: orphaned,
          floorMapKey,
          signIds: [],
        }),
        sign.id,
      );
      continue;
    }

    if (isRange(code)) {
      bucketPush(ranges, code, () => ({ code, signIds: [] }), sign.id);
      continue;
    }

    const floorMapKey = resolveFloorMapKey(code);
    if (floorMapKey) {
      bucketPush(creates, code, () => ({ code, floorMapKey, signIds: [] }), sign.id);
    } else {
      bucketPush(
        unmatched,
        code,
        () => ({ code, reason: "no-map" as const, signIds: [] }),
        sign.id,
      );
    }
  }

  const linkArr = [...links.values()];
  const createArr = [...creates.values()];
  const rangeArr = [...ranges.values()];
  const unmatchedArr = [...unmatched.values()];
  const overwriteArr = [...overwrite.values()];

  // Distinct orphaned matched rooms with a resolvable map → re-home targets.
  const rehome = linkArr
    .filter((l) => l.roomOrphaned && l.floorMapKey)
    .map((l) => ({ roomId: l.roomId, floorMapKey: l.floorMapKey as string }));

  const sum = (groups: { signIds: number[] }[]): number =>
    groups.reduce((n, g) => n + g.signIds.length, 0);

  return {
    links: linkArr,
    creates: createArr,
    ranges: rangeArr,
    unmatched: unmatchedArr,
    overwrite: overwriteArr,
    rehome,
    counts: {
      signsConsidered: signs.length,
      link: sum(linkArr),
      create: sum(createArr),
      range: sum(rangeArr),
      unmatched: sum(unmatchedArr),
      overwrite: sum(overwriteArr),
      distinctRoomsToPlace: linkArr.length + createArr.length,
      orphanRoomsToRehome: rehome.length,
    },
  };
}
