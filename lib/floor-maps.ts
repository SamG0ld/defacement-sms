import { cache } from "react";

import { prisma } from "@/lib/db";
import { buildFloorResolver, type FloorMapMeta, type FloorResolver } from "@/lib/sign-pin";

// DB-backed floor maps. Images live in the floor_maps table (Postgres bytea) and
// are managed in-app (admin) rather than bundled at build time — see the
// FloorMap model and app/api/maps/[key]/route.ts. This module is the read layer:
// metadata loaders for pages/components + the resolver builder for sign-pin.
// Image bytes are NOT loaded here (only the route handler fetches them).

// The shape the map components consume. `src` points at the cached image route.
export type FloorMapView = { id: number; key: string; src: string; label: string };

// The cached, auth-gated route that serves a floor map's image bytes.
export function floorImageSrc(key: string): string {
  return `/api/maps/${encodeURIComponent(key)}`;
}

// One metadata query per request (no image bytes), memoized so the page, its
// components, and the resolver all share a single round-trip. Ordered by
// sortOrder so the first map for a zone is its default floor.
const loadEnabledFloorMaps = cache(
  async (): Promise<(FloorMapMeta & { id: number; label: string })[]> => {
    const rows = await prisma.floorMap.findMany({
      where: { enabled: true },
      select: { id: true, key: true, label: true, zone: { select: { zoneCode: true } } },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      zoneCode: r.zone?.zoneCode ?? null,
    }));
  },
);

// All enabled floor maps, view-shaped (for tabs, selectors, the overview).
export async function getEnabledFloorMaps(): Promise<FloorMapView[]> {
  const maps = await loadEnabledFloorMaps();
  return maps.map((m) => ({ id: m.id, key: m.key, src: floorImageSrc(m.key), label: m.label }));
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
// "Manage floors" UI on /map. No image bytes — the thumbnail loads via the image route.
export type FloorMapAdminRow = {
  id: number;
  key: string;
  label: string;
  src: string;
  enabled: boolean;
  sortOrder: number;
  zoneCode: string | null;
  width: number | null;
  height: number | null;
};

// All floor maps for the admin manager, ordered for display. Not cached/filtered
// to enabled — the manager needs the full set including disabled.
export async function getAllFloorMaps(): Promise<FloorMapAdminRow[]> {
  const rows = await prisma.floorMap.findMany({
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
  });
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
  }));
}
