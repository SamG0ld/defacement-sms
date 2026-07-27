"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/log";
import {
  floorMapIdForKey,
  getFloorResolver,
  isValidFloorKey,
  zoneCodeForFloorKey,
} from "@/lib/floor-maps";
import {
  MAX_IMAGE_BYTES,
  validateImageUpload,
  type ImageValidationError,
  type SniffedImage,
} from "@/lib/image-upload";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { requireRole } from "@/lib/rbac";
import { resolveSignPin } from "@/lib/sign-pin";

function failSign(signId: number, message: string): never {
  redirect(`/signs/${signId}?error=${encodeURIComponent(message)}`);
}
function failRooms(floor: string, message: string): never {
  const params = new URLSearchParams({ error: message });
  if (floor) params.set("floor", floor);
  redirect(`/map?${params.toString()}`);
}
function failFloors(message: string): never {
  // Reopen the floor manager so the error is shown in context.
  redirect(`/map?manage=1&error=${encodeURIComponent(message)}`);
}

const OVER_BUDGET = "Too many changes at once — wait a minute and try again.";

// Per-actor backstop (60/min), the same bucket the sign + user actions use. A
// role gate is not a throttle: every action here is directly callable, and the
// floor-map uploads write up to 10 MB of bytea per call (#194).
async function overBudget(userId: string): Promise<boolean> {
  const budget = await checkMutationRateLimit(userId);
  return !budget.success;
}

// Coordinates are percentages of the floor image (0–100), so they're
// resolution-independent. coerce because they arrive as form strings.
const pct = z.coerce.number().min(0).max(100);

// Set / clear a sign's venue-map pin. Three modes:
//  - "override": drop a free pin (mapX/mapY/mapFloor) — wins over any room link.
//  - "room":     snap to a registry room (locationId) and clear the override so
//                the room's reusable pin shows through.
//  - "clear":    remove everything → unplaced.
export async function setSignMapPin(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireRole("lead");
  if (!Number.isInteger(signId) || signId <= 0) failSign(signId, "Invalid sign.");
  if (await overBudget(session.user.id)) failSign(signId, OVER_BUDGET);

  const mode = String(formData.get("mode") ?? "");

  if (mode === "clear") {
    await persistSign(signId, {
      mapX: null,
      mapY: null,
      mapFloor: null,
      locationId: null,
    });
    await audit(session, "sign.map_clear", `Cleared map pin for sign #${signId}`);
    return done(signId);
  }

  if (mode === "room") {
    const locationId = Number(formData.get("locationId"));
    if (!Number.isInteger(locationId) || locationId <= 0) {
      failSign(signId, "Choose a room.");
    }
    const room = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        locationCode: true,
        floorMap: { select: { key: true } },
        zone: { select: { zoneCode: true } },
      },
    });
    if (!room) failSign(signId, "Selected room no longer exists.");
    await assertRoomOnSignsFloor(signId, room);
    // Clear the override so the room's pin is what resolves.
    await persistSign(signId, {
      locationId: room.id,
      mapX: null,
      mapY: null,
      mapFloor: null,
    });
    await audit(
      session,
      "sign.map_room",
      `Linked sign #${signId} to room ${room.locationCode}`,
    );
    return done(signId);
  }

  if (mode === "override") {
    const parsed = z
      .object({ x: pct, y: pct, floor: z.string() })
      .safeParse({
        x: formData.get("x"),
        y: formData.get("y"),
        floor: formData.get("floor"),
      });
    if (!parsed.success) {
      failSign(signId, "Could not read the pin position.");
    }
    if (!(await isValidFloorKey(parsed.data.floor))) {
      failSign(signId, "That floor map no longer exists.");
    }
    // Clear any room link so location.signs reflects actual placement — an
    // override means this sign is no longer pinned via its registry room.
    await persistSign(signId, {
      mapX: parsed.data.x,
      mapY: parsed.data.y,
      mapFloor: parsed.data.floor,
      locationId: null,
    });
    await audit(session, "sign.map_pin", `Pinned sign #${signId} on the map`);
    return done(signId);
  }

  failSign(signId, "Unknown placement action.");
}

// Set a registry room's reusable pin (admin). Placed once per room, inherited by
// every sign linked to it, stable year over year.
export async function setRoomPin(
  locationId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireRole("admin");
  const floor = String(formData.get("floor") ?? "");
  if (await overBudget(session.user.id)) failRooms(floor, OVER_BUDGET);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    failRooms(floor, "Invalid room.");
  }

  const parsed = z.object({ x: pct, y: pct }).safeParse({
    x: formData.get("x"),
    y: formData.get("y"),
  });
  if (!parsed.success) failRooms(floor, "Could not read the pin position.");

  const room = await prisma.location.findUnique({
    where: { id: locationId },
    select: { locationCode: true },
  });
  if (!room) failRooms(floor, "Room not found.");

  try {
    await prisma.location.update({
      where: { id: locationId },
      data: { mapX: parsed.data.x, mapY: parsed.data.y },
    });
  } catch (err) {
    logError("map.set-room-pin", err);
    failRooms(floor, "Could not save the pin. Try again.");
  }

  await audit(
    session,
    "room.map_pin",
    `Placed room ${room.locationCode} on the map`,
  );
  revalidatePath("/map");
  redirect(`/map?floor=${encodeURIComponent(floor)}`);
}

// Add a room to the registry on a floor (admin). The registry is self-service —
// the owner knows the rooms — so rooms are added here, then placed. Room codes
// (e.g. "229") are stable year over year for the LVCC levels.
export async function createRoom(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  const floor = String(formData.get("floor") ?? "");
  if (await overBudget(session.user.id)) failRooms(floor, OVER_BUDGET);
  // Rooms attach to the floor map directly. The map's zone (if any) still tags
  // the room for deployment grouping, but is optional now.
  const floorMapId = await floorMapIdForKey(floor);
  if (!floorMapId) failRooms(floor, "Pick a valid floor.");

  const parsed = z
    .object({ code: z.string().trim().min(1).max(60) })
    .safeParse({ code: formData.get("code") });
  if (!parsed.success) failRooms(floor, "Enter a room code (e.g. 229).");

  const zoneCode = await zoneCodeForFloorKey(floor);
  const zone = zoneCode
    ? await prisma.zone.findUnique({
        where: { zoneCode },
        select: { id: true, building: true, floor: true },
      })
    : null;

  try {
    await prisma.location.create({
      data: {
        locationCode: parsed.data.code,
        building: zone?.building ?? "LVCC West",
        floor: zone?.floor ?? null,
        zoneId: zone?.id ?? null,
        floorMapId,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      failRooms(floor, `Room "${parsed.data.code}" already exists.`);
    }
    logError("map.create-room", err);
    failRooms(floor, "Could not add the room. Try again.");
  }

  await audit(
    session,
    "room.add",
    `Added room ${parsed.data.code} (${zoneCode ?? floor})`,
  );
  revalidatePath("/map");
  redirect(`/map?floor=${encodeURIComponent(floor)}`);
}

// ============================================================
// Floor map management (admin) — upload / replace / rename / enable / reorder.
// Images are validated by magic bytes (lib/image-upload) and stored as bytea;
// the cached route app/api/maps/[key] serves them. `key` is a stable slug
// derived from the label and is what Sign.mapFloor references, so it never
// changes on rename — only the label does.
// ============================================================

// Advisory-lock id guarding floor-map sortOrder assignment. Arbitrary but fixed
// — any two createFloorMap calls must pick the same number to take turns.
const FLOOR_SORT_LOCK = 4207348001;

// Add a floor map from an uploaded image (admin). Optionally linked to a zone so
// signs in that zone derive it as their default floor.
export async function createFloorMap(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);

  const label = String(formData.get("label") ?? "").trim();
  if (label.length < 2 || label.length > 80) failFloors("Enter a name (2–80 characters).");
  const key = slugifyFloorKey(label);
  if (!key) failFloors("Name must contain letters or numbers.");

  // Optional zone link.
  const zoneCode = String(formData.get("zoneCode") ?? "").trim();
  let zoneId: number | null = null;
  let building: string | null = null;
  let floor: string | null = null;
  if (zoneCode) {
    const zone = await prisma.zone.findUnique({
      where: { zoneCode },
      select: { id: true, building: true, floor: true },
    });
    if (!zone) failFloors("Pick a valid zone.");
    zoneId = zone.id;
    building = zone.building;
    floor = zone.floor;
  }

  const { bytes, image } = await readUploadedImage(formData);

  try {
    // sortOrder is max+1: a read-then-write that two simultaneous uploads could
    // both win, tying on the same order (#196). A transaction alone doesn't fix
    // that under READ COMMITTED — both would still read the same max — so the
    // pair is serialized on a transaction-scoped advisory lock, released with
    // the transaction. Only this action ever takes it.
    //
    // Both waits are bounded so a rare concurrent upload can't hold one of the
    // max:3 pool connections indefinitely: lock_timeout caps the wait FOR the
    // lock, and the transaction timeout is raised from Prisma's 5s default to
    // cover the ≤10 MB bytea insert now inside it (a cold database compute plus a
    // large floor plan can exceed 5s, which would fail an upload that used to
    // succeed).
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FLOOR_SORT_LOCK}::bigint)`;
        const max = await tx.floorMap.aggregate({ _max: { sortOrder: true } });
        await tx.floorMap.create({
          data: {
            key,
            label,
            building,
            floor,
            zoneId,
            imageData: Buffer.from(bytes),
            contentType: image.contentType,
            width: image.width,
            height: image.height,
            sortOrder: (max._max.sortOrder ?? 0) + 1,
          },
        });
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // The collision is on the derived key (e.g. two labels that slugify the
      // same), which may not visibly match an existing label — say so.
      failFloors(`A floor map with this name already exists (key "${key}" is taken). Try a slightly different name.`);
    }
    logError("map.create-floor", err);
    failFloors("Could not create the floor map. Try again.");
  }

  await audit(session, "floormap.create", `Added floor map ${key} (${label})`);
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// Replace a floor map's image (admin). The row's updatedAt bumps, busting the
// image route's ETag so the new image is picked up promptly.
export async function replaceFloorImage(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);
  const id = floorMapIdFrom(formData);

  const existing = await prisma.floorMap.findUnique({
    where: { id },
    select: { key: true },
  });
  if (!existing) failFloors("Floor map not found.");

  const { bytes, image } = await readUploadedImage(formData);

  try {
    await prisma.floorMap.update({
      where: { id },
      data: {
        imageData: Buffer.from(bytes),
        contentType: image.contentType,
        width: image.width,
        height: image.height,
      },
    });
  } catch (err) {
    logError("map.replace-image", err);
    failFloors("Could not replace the image. Try again.");
  }

  await audit(session, "floormap.replace_image", `Replaced image for floor map ${existing.key}`);
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// Rename a floor map's display label (admin). The key is intentionally NOT
// changed — Sign.mapFloor references it, so renames must not break placements.
export async function renameFloorMap(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);
  const id = floorMapIdFrom(formData);

  const label = String(formData.get("label") ?? "").trim();
  if (label.length < 2 || label.length > 80) failFloors("Enter a name (2–80 characters).");

  const existing = await prisma.floorMap.findUnique({ where: { id }, select: { key: true } });
  if (!existing) failFloors("Floor map not found.");

  try {
    await prisma.floorMap.update({ where: { id }, data: { label } });
  } catch (err) {
    logError("map.rename-floor", err);
    failFloors("Could not rename the floor map. Try again.");
  }
  await audit(session, "floormap.rename", `Renamed floor map ${existing.key} to "${label}"`);
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// Enable / disable a floor map (admin). Disabled maps drop out of every picker
// (getEnabledFloorMaps) but their image still serves, so existing references
// don't 404.
export async function setFloorEnabled(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);
  const id = floorMapIdFrom(formData);
  const enabled = String(formData.get("enabled") ?? "") === "1";

  const existing = await prisma.floorMap.findUnique({ where: { id }, select: { key: true } });
  if (!existing) failFloors("Floor map not found.");

  try {
    await prisma.floorMap.update({ where: { id }, data: { enabled } });
  } catch (err) {
    logError("map.set-enabled", err);
    failFloors("Could not update the floor map. Try again.");
  }
  await audit(
    session,
    enabled ? "floormap.enable" : "floormap.disable",
    `${enabled ? "Enabled" : "Disabled"} floor map ${existing.key}`,
  );
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// Move a floor map up/down in display order (admin) by swapping sortOrder with
// its neighbour. A no-op at the edges. Audited like every other structural
// floor-map change, so an unexplained reordering is traceable to who and when
// (#195) — the swap is one line in /activity, not a flood.
export async function reorderFloorMap(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);
  const id = floorMapIdFrom(formData);
  const dir = String(formData.get("dir") ?? "");
  if (dir !== "up" && dir !== "down") failFloors("Invalid move.");

  const all = await prisma.floorMap.findMany({
    select: { id: true, key: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const idx = all.findIndex((m) => m.id === id);
  if (idx === -1) failFloors("Floor map not found.");

  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= all.length) redirect("/map?manage=1"); // edge → no-op

  const a = all[idx];
  const b = all[swapIdx];
  // Distinct sortOrder values are normal. On a tie between this exact pair, nudge
  // b past a so the swap still reorders them (a's own write is a no-op in a tie).
  // A wider multi-row tie is an admin edge case and isn't fully normalised here.
  const aOrder = a.sortOrder === b.sortOrder ? a.sortOrder + (dir === "up" ? 1 : -1) : a.sortOrder;
  await prisma.$transaction([
    prisma.floorMap.update({ where: { id: a.id }, data: { sortOrder: b.sortOrder } }),
    prisma.floorMap.update({ where: { id: b.id }, data: { sortOrder: aOrder } }),
  ]);

  await audit(
    session,
    "floormap.reorder",
    `Moved floor map ${a.key} ${dir} (swapped with ${b.key})`,
  );
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// Delete a floor map (admin). Hard delete — the row and its image bytes are gone,
// unlike disable which only hides it. FK-safe: Location.floorMap is
// onDelete: SetNull, so rooms on this map detach but survive; Sign.mapFloor is a
// plain string (no FK), so any sign still pinned to this key silently resolves to
// unplaced. We count both first and fold them into the audit detail so the blast
// radius stays traceable. The UI gates this behind a confirm (DeleteFloorButton),
// since it can't be undone.
export async function deleteFloorMap(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  if (await overBudget(session.user.id)) failFloors(OVER_BUDGET);
  const id = floorMapIdFrom(formData);

  const existing = await prisma.floorMap.findUnique({
    where: { id },
    select: { key: true, label: true },
  });
  if (!existing) failFloors("Floor map not found.");

  let roomCount = 0;
  let clearedPins = 0;
  try {
    // One transaction: (1) count rooms about to detach (SetNull) for the audit,
    // (2) CLEAR the override pins of every sign placed on this map, then (3) delete
    // the map. Clearing (2) is load-bearing: if we only deleted the map, a sign
    // whose mapFloor no longer resolves would fall back to its zone's default map
    // and re-show its now-meaningless coordinates on a DIFFERENT floor (see
    // resolveSignPin in lib/sign-pin.ts) — so a "removed" pin could silently jump
    // to the wrong map instead of going unplaced. Nulling the override makes it
    // genuinely unplaced, matching the confirm/audit wording.
    const [rooms, cleared] = await prisma.$transaction([
      prisma.location.count({ where: { floorMapId: id } }),
      prisma.sign.updateMany({
        where: { mapFloor: existing.key },
        data: { mapX: null, mapY: null, mapFloor: null },
      }),
      prisma.floorMap.delete({ where: { id } }),
    ]);
    roomCount = rooms;
    clearedPins = cleared.count;
  } catch (err) {
    logError("map.delete-floor", err);
    failFloors("Could not delete the floor map. Try again.");
  }

  await audit(
    session,
    "floormap.delete",
    `Deleted floor map ${existing.key} (${existing.label}) — ${roomCount} room(s) detached, ${clearedPins} sign pin(s) cleared (now unplaced)`,
  );
  revalidatePath("/map");
  redirect("/map?manage=1");
}

// --- shared helpers ---

// Stable URL slug from a display label (e.g. "LVCC West — Hall 1" →
// "lvcc-west-hall-1"). Stored as FloorMap.key and referenced by Sign.mapFloor.
function slugifyFloorKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function floorMapIdFrom(formData: FormData): number {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) failFloors("Invalid floor map.");
  return id;
}

const IMAGE_ERROR: Record<ImageValidationError, string> = {
  empty: "The image file is empty.",
  too_large: `Image is too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`,
  unsupported_type: "Unsupported image — upload a PNG, JPEG, or WebP.",
  bad_dimensions: "Couldn't read the image's dimensions — the file may be corrupt.",
  too_many_pixels: "Image resolution is too large (max 40 megapixels).",
};

// Read + validate an uploaded image from a multipart form. Validation is by
// magic bytes (not the spoofable client MIME type) via lib/image-upload.
async function readUploadedImage(
  formData: FormData,
): Promise<{ bytes: Uint8Array; image: SniffedImage }> {
  const file = formData.get("image");
  if (!(file instanceof File) || file.size === 0) failFloors("Choose an image file.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = validateImageUpload(bytes);
  if (!result.ok) failFloors(IMAGE_ERROR[result.error]);
  return { bytes, image: result.image };
}

// Reject linking a sign to a room that lives on a different floor map (#181).
// The picker in WhereItGoes.tsx only ever lists rooms on the sign's own resolved
// floor, but this action is directly callable with an arbitrary signId +
// locationId — and once linked, resolveSignPin renders the sign wherever the
// ROOM's map says, so a mismatch silently sends field crews to the wrong floor.
//
// Two floors count as the sign's own: the one it currently RESOLVES to (what the
// picker lists — which can come from an override pin on another floor) and its
// ZONE's default. Accepting both is what keeps this from becoming a trap: a sign
// already mislinked to the wrong floor resolves there, so checking the resolved
// floor alone would refuse the correct room and leave the bad link stuck.
//
// When either side has no floor context at all — a sign with no zone and no pin,
// or a room attached to neither a map nor a zone — there's nothing to contradict,
// and the room pin would resolve onto the sign's own zone floor anyway, so the
// link is allowed.
async function assertRoomOnSignsFloor(
  signId: number,
  room: {
    floorMap: { key: string } | null;
    zone: { zoneCode: string } | null;
  },
): Promise<void> {
  const [sign, floors] = await Promise.all([
    prisma.sign.findUnique({
      where: { id: signId },
      select: {
        mapX: true,
        mapY: true,
        mapFloor: true,
        zone: { select: { zoneCode: true } },
        location: {
          select: {
            mapX: true,
            mapY: true,
            zone: { select: { zoneCode: true } },
            floorMap: { select: { key: true } },
          },
        },
      },
    }),
    getFloorResolver(),
  ]);
  if (!sign) failSign(signId, "Sign not found.");

  const signFloorKeys = [
    resolveSignPin(sign, floors)?.floorKey,
    floors.floorKeyForZone(sign.zone?.zoneCode),
  ].filter((k): k is string => !!k);
  const roomFloorKey =
    room.floorMap && floors.isValidFloorKey(room.floorMap.key)
      ? room.floorMap.key
      : floors.floorKeyForZone(room.zone?.zoneCode);

  if (signFloorKeys.length && roomFloorKey && !signFloorKeys.includes(roomFloorKey)) {
    failSign(signId, "That room is on a different floor.");
  }
}

type SignMapData = {
  mapX?: number | null;
  mapY?: number | null;
  mapFloor?: string | null;
  locationId?: number | null;
};

async function persistSign(signId: number, data: SignMapData): Promise<void> {
  try {
    await prisma.sign.update({ where: { id: signId }, data });
  } catch (err) {
    logError("map.set-sign-pin", err);
    failSign(signId, "Could not save the pin. Try again.");
  }
}

async function audit(
  session: { user: { id: string; email?: string | null } },
  action: string,
  detail: string,
): Promise<void> {
  await recordAudit({
    action,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail,
  });
}

function done(signId: number): never {
  revalidatePath(`/signs/${signId}`);
  revalidatePath("/map");
  redirect(`/signs/${signId}`);
}
