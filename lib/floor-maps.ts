import { cache } from "react";

import { prisma } from "@/lib/db";
import { buildFloorResolver, type FloorMapMeta, type FloorResolver } from "@/lib/sign-pin";

// DB-backed floor maps. Images live in the floor_maps table (Postgres bytea) and
// are managed in-app (admin) rather than bundled at build time — see the
// FloorMap model and app/api/maps/[key]/route.ts. This module is the read layer:
// metadata loaders for pages/components + the resolver builder for sign-pin.
// Image bytes are NOT loaded here (only the route handler fetches them).

// The shape the map components consume. `src` points at the cached image route.
// width/height are the stored image pixels (advisory) — used to derive how far
// the zoom UI may scale in (lib/map-gesture deriveMaxScale).
export type FloorMapView = {
  id: number;
  key: string;
  src: string;
  label: string;
  width: number | null;
  height: number | null;
};

// The cached, auth-gated route that serves a floor map's image bytes.
export function floorImageSrc(key: string): string {
  return `/api/maps/${encodeURIComponent(key)}`;
}

// One metadata query per request (no image bytes), memoized so the page, its
// components, and the resolver all share a single round-trip. Ordered by
// sortOrder so the first map for a zone is its default floor.
const loadEnabledFloorMaps = cache(
  async (): Promise<
    (FloorMapMeta & {
      id: number;
      label: string;
      width: number | null;
      height: number | null;
    })[]
  > => {
    const rows = await prisma.floorMap.findMany({
      where: { enabled: true },
      select: {
        id: true,
        key: true,
        label: true,
        width: true,
        height: true,
        zone: { select: { zoneCode: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      width: r.width,
      height: r.height,
      zoneCode: r.zone?.zoneCode ?? null,
    }));
  },
);

// All enabled floor maps, view-shaped (for tabs, selectors, the overview).
export async function getEnabledFloorMaps(): Promise<FloorMapView[]> {
  const maps = await loadEnabledFloorMaps();
  return maps.map((m) => ({
    id: m.id,
    key: m.key,
    src: floorImageSrc(m.key),
    label: m.label,
    width: m.width,
    height: m.height,
  }));
}

// The FloorMap id for a key (for attaching rooms to a map). Enabled maps only.
export async function floorMapIdForKey(
  key: string | null | undefined,
): Promise<number | null> {
  if (!key) return null;
  const maps = await loadEnabledFloorMaps();
  return maps.find((m) => m.key === key)?.id ?? null;
}

// The sync resolver resolveSignPin needs, built from the loaded maps.
export async function getFloorResolver(): Promise<FloorResolver> {
  return buildFloorResolver(await loadEnabledFloorMaps());
}

// Is this a key of a known, enabled floor map? (For server-action validation.)
export async function isValidFloorKey(
  key: string | null | undefined,
): Promise<boolean> {
  if (!key) return false;
  const maps = await loadEnabledFloorMaps();
  return maps.some((m) => m.key === key);
}

// The zone code a floor map represents (for adding rooms under the right zone).
export async function zoneCodeForFloorKey(
  key: string | null | undefined,
): Promise<string | null> {
  if (!key) return null;
  const maps = await loadEnabledFloorMaps();
  return maps.find((m) => m.key === key)?.zoneCode ?? null;
}

// Admin manager row: every floor map (incl. disabled), with metadata for the
// "Manage floors" UI on /map. Not exported — callers use type inference from
// getAllFloorMaps(); no external code names this type directly.
type FloorMapAdminRow = {
  id: number;
  key: string;
  label: string;
  src: string;
  enabled: boolean;
  sortOrder: number;
  zoneCode: string | null;
  width: number | null;
  height: number | null;
  // Signs whose own override pins this floor key (Sign.mapFloor). These become
  // "unplaced" if the map is deleted — surfaced so the delete confirm can warn.
  pinnedSignCount: number;
};

// All floor maps for the admin manager, ordered for display. Not cached/filtered
// to enabled — the manager needs the full set including disabled.
export async function getAllFloorMaps(): Promise<FloorMapAdminRow[]> {
  const [rows, pinCounts] = await Promise.all([
    prisma.floorMap.findMany({
      select: {
        id: true,
        key: true,
        label: true,
        enabled: true,
        sortOrder: true,
        width: true,
        height: true,
        zone: { select: { zoneCode: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    // One grouped count of override-pinned signs per floor key — cheaper than a
    // per-map query, and only override pins (mapFloor) are cleared by a delete.
    // Exclude archived/removed signs so the "will become unplaced" warning
    // reflects LIVE pins only (matches how active counts are computed elsewhere —
    // ARCHIVED_STATUS in app/(app)/signs/_lib.ts).
    prisma.sign.groupBy({
      by: ["mapFloor"],
      where: { mapFloor: { not: null }, status: { not: "archived" } },
      _count: { _all: true },
    }),
  ]);
  const pinsByKey = new Map(
    pinCounts.map((p) => [p.mapFloor, p._count._all] as const),
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    src: floorImageSrc(r.key),
    enabled: r.enabled,
    sortOrder: r.sortOrder,
    zoneCode: r.zone?.zoneCode ?? null,
    width: r.width,
    height: r.height,
    pinnedSignCount: pinsByKey.get(r.key) ?? 0,
  }));
}
