import Link from "next/link";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getAllFloorMaps, getEnabledFloorMaps } from "@/lib/floor-maps";
import { getSession } from "@/lib/session";

import {
  createFloorMap,
  createRoom,
  renameFloorMap,
  reorderFloorMap,
  replaceFloorImage,
  setFloorEnabled,
  setRoomPin,
} from "./actions";
import { FloorPinView } from "./_components/FloorPinView";
import { MapPinPicker } from "./_components/MapPinPicker";

type Props = {
  searchParams: Promise<{ floor?: string; room?: string; manage?: string; error?: string }>;
};

// The Maps page (admin) — one screen: pick a floor (tabs), add and place rooms on
// it, and manage the floor images themselves behind a "Manage floors" disclosure.
// Replaces the former /map hub + /map/floors + /map/rooms split.
export default async function MapPage({ searchParams }: Props) {
  const session = await getSession();
  if (session?.user?.role !== "admin") redirect("/");

  const sp = await searchParams;
  const [enabled, allMaps, zones] = await Promise.all([
    getEnabledFloorMaps(),
    getAllFloorMaps(),
    prisma.zone.findMany({
      where: { isActive: true },
      select: { zoneCode: true, zoneName: true },
      orderBy: { deploymentPriority: "asc" },
    }),
  ]);

  const fm = enabled.find((m) => m.key === sp.floor) ?? enabled[0] ?? null;
  // Open the floor manager when asked (a floor action redirects back with it
  // open), or automatically when there's no usable floor yet.
  const manageOpen = sp.manage === "1" || !fm;

  const rooms = fm
    ? await prisma.location.findMany({
        where: { floorMapId: fm.id },
        select: { id: true, locationCode: true, mapX: true, mapY: true },
        orderBy: { locationCode: "asc" },
      })
    : [];
  const placed = rooms.filter((r) => r.mapX !== null && r.mapY !== null);
  const selected = fm && sp.room
    ? (rooms.find((r) => r.id === Number(sp.room)) ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Maps</h1>
        <p className="text-sm text-zinc-400">
          Pick a floor, then add and place rooms on it. Positions are reused every
          year; signs in a room inherit its pin.
        </p>
      </div>

      {sp.error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {sp.error}
        </div>
      )}

      {/* Floor management — tucked away; the day-to-day task is placing rooms. */}
      <details open={manageOpen} className="rounded-lg border border-zinc-800 bg-zinc-950">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-zinc-300 hover:text-zinc-100">
          Manage floors
          <span className="ml-2 text-xs font-normal text-zinc-500">
            upload · replace · rename · enable/disable · reorder
          </span>
        </summary>
        <div className="grid gap-6 border-t border-zinc-800 p-4 lg:grid-cols-[1fr_320px]">
          {/* All floors (incl. disabled, so they can be re-enabled) */}
          <div className="space-y-3">
            {allMaps.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No floor maps yet. Upload one with the form on the right.
              </p>
            ) : (
              <ul className="space-y-3">
                {allMaps.map((m, i) => (
                  <li
                    key={m.id}
                    className="flex gap-4 rounded-lg border border-zinc-800 bg-black/30 p-3"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- DB-served floorplan */}
                    <img
                      src={m.src}
                      alt={m.label}
                      className="h-20 w-28 shrink-0 rounded border border-zinc-800 bg-white object-contain"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-100">{m.label}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                            m.enabled
                              ? "bg-emerald-950 text-emerald-300"
                              : "bg-zinc-800 text-zinc-500"
                          }`}
                        >
                          {m.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-zinc-500">
                        {m.key}
                        {m.zoneCode && ` · ${m.zoneCode}`}
                        {m.width && m.height && ` · ${m.width}×${m.height}`}
                      </p>

                      <div className="mt-auto flex flex-wrap items-center gap-2">
                        <form action={reorderFloorMap}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="dir" value="up" />
                          <button
                            type="submit"
                            disabled={i === 0}
                            aria-label="Move up"
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                          >
                            ↑
                          </button>
                        </form>
                        <form action={reorderFloorMap}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="dir" value="down" />
                          <button
                            type="submit"
                            disabled={i === allMaps.length - 1}
                            aria-label="Move down"
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                          >
                            ↓
                          </button>
                        </form>

                        <form action={setFloorEnabled}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="enabled" value={m.enabled ? "0" : "1"} />
                          <button
                            type="submit"
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            {m.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>

                        <form action={renameFloorMap} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={m.id} />
                          <input
                            type="text"
                            name="label"
                            defaultValue={m.label}
                            required
                            minLength={2}
                            maxLength={80}
                            className="w-36 rounded border border-zinc-700 bg-black px-2 py-0.5 text-xs text-zinc-100"
                          />
                          <button
                            type="submit"
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            Rename
                          </button>
                        </form>

                        <form action={replaceFloorImage} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={m.id} />
                          <input
                            type="file"
                            name="image"
                            accept="image/png,image/jpeg,image/webp"
                            required
                            className="w-40 text-xs text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-800 file:px-2 file:py-0.5 file:text-zinc-200"
                          />
                          <button
                            type="submit"
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            Replace
                          </button>
                        </form>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a new floor */}
          <form action={createFloorMap} className="h-fit space-y-3 rounded-lg border border-zinc-800 bg-black/30 p-4">
            <h2 className="text-sm font-semibold text-zinc-300">Add a floor</h2>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Name
              <input
                type="text"
                name="label"
                required
                minLength={2}
                maxLength={80}
                placeholder="e.g. LVCC West — Hall 1"
                className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Zone (optional — sets a default floor for signs in that zone)
              <select
                name="zoneCode"
                defaultValue=""
                className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
              >
                <option value="">— none —</option>
                {zones.map((z) => (
                  <option key={z.zoneCode} value={z.zoneCode}>
                    {z.zoneName} ({z.zoneCode})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Image (PNG, JPEG, or WebP — max 10 MB)
              <input
                type="file"
                name="image"
                accept="image/png,image/jpeg,image/webp"
                required
                className="text-xs text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-zinc-200"
              />
            </label>
            <button type="submit" className="btn-primary w-full rounded px-3 py-1.5 text-sm font-medium">
              Upload floor
            </button>
          </form>
        </div>
      </details>

      {fm ? (
        <>
          {/* Floor tabs */}
          <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800">
            {enabled.map((m) => (
              <Link
                key={m.key}
                href={`/map?floor=${m.key}${manageOpen ? "&manage=1" : ""}`}
                className={`rounded-t border-b-2 px-3 py-1.5 text-sm ${
                  m.key === fm.key
                    ? "border-accent text-zinc-100"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m.label}
              </Link>
            ))}
          </div>

          {/* Map + rooms */}
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-3">
              {selected ? (
                <>
                  <p className="text-sm text-zinc-300">
                    Placing <span className="font-mono">{selected.locationCode}</span> — tap the
                    map.{" "}
                    <Link href={`/map?floor=${fm.key}`} className="text-accent hover:underline">
                      done
                    </Link>
                  </p>
                  <MapPinPicker
                    src={fm.src}
                    label={fm.label}
                    initial={
                      selected.mapX !== null && selected.mapY !== null
                        ? { x: selected.mapX, y: selected.mapY }
                        : null
                    }
                    action={setRoomPin.bind(null, selected.id)}
                    hiddenFields={{ floor: fm.key }}
                    saveLabel={`Save ${selected.locationCode}`}
                  />
                </>
              ) : (
                <FloorPinView
                  src={fm.src}
                  label={fm.label}
                  pins={placed.map((r) => ({
                    key: r.id,
                    xPct: r.mapX as number,
                    yPct: r.mapY as number,
                    title: r.locationCode,
                  }))}
                />
              )}
            </div>

            <div className="space-y-4">
              <form
                action={createRoom}
                className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3"
              >
                <input type="hidden" name="floor" value={fm.key} />
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Add a room to {fm.label}
                  <input
                    type="text"
                    name="code"
                    required
                    placeholder="e.g. 229"
                    className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                </label>
                <button type="submit" className="btn-primary rounded px-3 py-1.5 text-sm font-medium">
                  Add room
                </button>
              </form>

              <div className="rounded-lg border border-zinc-800">
                <div className="border-b border-zinc-800 px-3 py-2 text-xs uppercase text-zinc-500">
                  Rooms ({placed.length}/{rooms.length} placed)
                </div>
                <ul className="divide-y divide-zinc-800">
                  {rooms.length === 0 ? (
                    <li className="px-3 py-3 text-sm text-zinc-500">
                      No rooms yet — add one above.
                    </li>
                  ) : (
                    rooms.map((r) => {
                      const isPlaced = r.mapX !== null && r.mapY !== null;
                      return (
                        <li
                          key={r.id}
                          className="flex items-center justify-between px-3 py-2 text-sm"
                        >
                          <span className="font-mono text-zinc-200">
                            {r.locationCode}
                            <span
                              className={`ml-2 text-[10px] uppercase ${isPlaced ? "text-emerald-400" : "text-zinc-600"}`}
                            >
                              {isPlaced ? "● placed" : "○ unplaced"}
                            </span>
                          </span>
                          <Link
                            href={`/map?floor=${fm.key}&room=${r.id}`}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            {isPlaced ? "move" : "place"}
                          </Link>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-500">
          No floor maps yet — add one under <span className="text-zinc-300">Manage floors</span> above.
        </p>
      )}
    </div>
  );
}
