import { prisma } from "@/lib/db";
import { getEnabledFloorMaps, getFloorResolver } from "@/lib/floor-maps";
import { resolveSignPin, type SignPinInput } from "@/lib/sign-pin";

import { setSignMapPin } from "../actions";
import { FloorPinView } from "./FloorPinView";
import { FloorReassign } from "./FloorReassign";

// "Where it goes" panel for the sign detail page. Shows the sign's resolved pin
// on its floor map, and (for lead+) the placement controls: pick the floor map
// and drop a pin, snap to a registry room, or clear. The floor picker is the fix
// for a wrong/coarse zone — placement is no longer locked to the sign's zone.
export async function WhereItGoes({
  sign,
  canManage,
}: {
  sign: SignPinInput & { id: number; deployPhotoUrl?: string | null };
  canManage: boolean;
}) {
  const [floors, floorMaps] = await Promise.all([
    getFloorResolver(),
    getEnabledFloorMaps(),
  ]);
  const resolved = resolveSignPin(sign, floors);
  // Read-only view renders on the resolved pin's floor. Derived from the already
  // loaded list (same memoized query) — no extra round-trip.
  const viewFm = resolved
    ? (floorMaps.find((m) => m.key === resolved.floorKey) ?? null)
    : null;
  // The reassign picker defaults to the resolved floor, else the sign's zone
  // default, else the first available map.
  const defaultFloorKey =
    resolved?.floorKey ?? floors.floorKeyForZone(sign.zone?.zoneCode) ?? floorMaps[0]?.key ?? null;

  // Snap-to-room options: placed rooms on the floor MAP the sign sits on (its
  // resolved/zone floor) — keyed by floorMapId so it's correct even for a map
  // with no zone link. (Not the picker's currently-selected floor, which can be
  // switched client-side.)
  const roomsFloorKey =
    resolved?.floorKey ?? floors.floorKeyForZone(sign.zone?.zoneCode) ?? null;
  const roomsFloorMapId = roomsFloorKey
    ? (floorMaps.find((m) => m.key === roomsFloorKey)?.id ?? null)
    : null;
  const rooms =
    canManage && roomsFloorMapId
      ? await prisma.location.findMany({
          where: { floorMapId: roomsFloorMapId, mapX: { not: null }, mapY: { not: null } },
          select: { id: true, locationCode: true },
          orderBy: { locationCode: "asc" },
        })
      : [];

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Where it goes</h2>
        {resolved && (
          <span className="text-xs text-zinc-500">
            {viewFm?.label} · {resolved.source === "room" ? "room" : "custom pin"}
          </span>
        )}
      </div>

      {/* Read-only users see just the resolved pin. Lead+ get the single
          interactive map below (which shows the same pin), so we don't render a
          second read-only map here for them. */}
      {!canManage &&
        (resolved && viewFm ? (
          <FloorPinView
            src={viewFm.src}
            label={viewFm.label}
            pins={[
              {
                key: sign.id,
                xPct: resolved.xPct,
                yPct: resolved.yPct,
                active: true,
                title: "This sign",
                // Deployed signs (deployPhotoUrl set) get a tappable pin that
                // opens the placed-sign photo; otherwise a plain marker.
                photoSignId: sign.deployPhotoUrl ? sign.id : undefined,
              },
            ]}
          />
        ) : (
          <p className="text-sm text-zinc-500">
            Not placed on the map yet. Ask a lead to set its location.
          </p>
        ))}

      {/* Placement controls + the single map (lead+). */}
      {canManage &&
        (floorMaps.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No floor maps yet — add one under Maps.
          </p>
        ) : (
          <div className="space-y-4">
            <FloorReassign
              floors={floorMaps}
              initialFloorKey={defaultFloorKey}
              // Only pre-fill an EDITABLE pin from an existing override. A
              // room-sourced pin is shown as a read-only "current" marker
              // instead, so a stray Save can't convert room→override.
              initialPos={
                resolved?.source === "override"
                  ? { x: resolved.xPct, y: resolved.yPct }
                  : null
              }
              current={
                resolved ? { floorKey: resolved.floorKey, x: resolved.xPct, y: resolved.yPct } : null
              }
              action={setSignMapPin.bind(null, sign.id)}
            />

            <div className="flex flex-wrap items-end gap-3">
              {rooms.length > 0 && (
                <form
                  action={setSignMapPin.bind(null, sign.id)}
                  className="flex items-end gap-2"
                >
                  <input type="hidden" name="mode" value="room" />
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    Or snap to a room
                    <select
                      name="locationId"
                      defaultValue=""
                      required
                      className="field"
                    >
                      <option value="" disabled>
                        choose room…
                      </option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.locationCode}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="btn">
                    Use room
                  </button>
                </form>
              )}

              {resolved && (
                <form action={setSignMapPin.bind(null, sign.id)}>
                  <input type="hidden" name="mode" value="clear" />
                  <button type="submit" className="btn hover:text-[var(--danger)]">
                    Clear pin
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
    </section>
  );
}
