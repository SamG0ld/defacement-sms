"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { logError } from "@/lib/log";
import {
  buildFloorMapResolver,
  classifyAutoPin,
  type AutoPinPlan,
  type AutoPinRoom,
  type AutoPinSign,
  type FloorMapRule,
} from "@/lib/auto-pin";
import type { Prisma } from "@/app/generated/prisma/client";

import { CHUNK, chunk } from "../_bulk-shared";

// The admin-editable prefix→map table posted from the wizard. Kept small and
// validated at the boundary — the classifier trusts it as a resolver.
const ruleSchema = z
  .array(
    z.discriminatedUnion("match", [
      z.object({
        match: z.literal("prefix"),
        value: z.string().trim().min(1).max(20),
        floorMapKey: z.string().min(1).max(120),
      }),
      z.object({
        match: z.literal("numeric"),
        floorMapKey: z.string().min(1).max(120),
      }),
    ]),
  )
  .max(50);

const applyOptsSchema = z.object({
  // Opt-in: also re-pin signs that already have a manual placement / room link.
  // Off by default so a bulk run can never silently overwrite a hand-placed pin.
  includeOverwrite: z.boolean().default(false),
});

export type EnabledMap = { key: string; label: string };

export type AutoPinPreview = {
  plan: AutoPinPlan;
  enabledMaps: EnabledMap[];
  // Rule targets that don't match an enabled floor map — the wizard must fix
  // these before apply (the resolver would produce an unusable map key).
  invalidRuleKeys: string[];
};

export type AutoPinApplyResult = {
  created: number; // rooms created
  rehomed: number; // orphaned rooms attached to a map
  linked: number; // signs linked to a room
  skipped: number; // groups whose floor map key couldn't be resolved
};

// The columns the classifier + reversibility need. Excludes archived + test rows
// so a bulk run never pins a soft-removed or fixture sign.
const SIGN_SELECT = {
  id: true,
  exactDestination: true,
  locationId: true,
  mapX: true,
  mapY: true,
} satisfies Prisma.SignSelect;

// What a created/re-homed room needs from its target map. building/floor/zoneId
// mirror createRoom (map/actions.ts): derived from the map's zone, "LVCC West"
// fallback when the map has no zone — which is the DC34 case (the 3 new maps are
// zone-less, so these come back building "LVCC West", floor/zoneId null).
type MapMeta = {
  id: number;
  building: string;
  floor: string | null;
  zoneId: number | null;
};

async function loadData(): Promise<{
  signs: AutoPinSign[];
  rooms: AutoPinRoom[];
  enabledMaps: EnabledMap[];
  mapIdByKey: Map<string, number>;
  mapMetaByKey: Map<string, MapMeta>;
}> {
  const [signs, rooms, maps] = await Promise.all([
    prisma.sign.findMany({
      where: { status: { not: "archived" }, isTestData: false },
      select: SIGN_SELECT,
    }),
    prisma.location.findMany({
      select: { id: true, locationCode: true, floorMapId: true },
      // Stable so "first wins" on a normalized-code collision is deterministic.
      orderBy: { id: "asc" },
    }),
    prisma.floorMap.findMany({
      where: { enabled: true },
      select: {
        id: true,
        key: true,
        label: true,
        zone: { select: { id: true, building: true, floor: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    signs,
    rooms,
    enabledMaps: maps.map((m) => ({ key: m.key, label: m.label })),
    mapIdByKey: new Map(maps.map((m) => [m.key, m.id])),
    mapMetaByKey: new Map(
      maps.map((m) => [
        m.key,
        {
          id: m.id,
          building: m.zone?.building ?? "LVCC West",
          floor: m.zone?.floor ?? null,
          zoneId: m.zone?.id ?? null,
        },
      ]),
    ),
  };
}

function invalidRuleKeys(
  rules: FloorMapRule[],
  mapIdByKey: Map<string, number>,
): string[] {
  return [
    ...new Set(
      rules.map((r) => r.floorMapKey).filter((k) => !mapIdByKey.has(k)),
    ),
  ];
}

export async function previewAutoPin(
  rulesInput: unknown,
): Promise<AutoPinPreview> {
  const session = await requireRole("admin");
  const { success } = await checkActionRateLimit(`autopin:${session.user.id}`);
  if (!success) throw new Error("rate-limited");

  const rules = ruleSchema.parse(rulesInput);
  const { signs, rooms, enabledMaps, mapIdByKey } = await loadData();

  const resolver = buildFloorMapResolver(rules);
  const plan = classifyAutoPin(signs, rooms, resolver);

  return { plan, enabledMaps, invalidRuleKeys: invalidRuleKeys(rules, mapIdByKey) };
}

export async function applyAutoPin(
  rulesInput: unknown,
  optsInput: unknown,
): Promise<AutoPinApplyResult> {
  const session = await requireRole("admin");
  const { success } = await checkActionRateLimit(`autopin:${session.user.id}`);
  if (!success) throw new Error("rate-limited");

  const rules = ruleSchema.parse(rulesInput);
  const opts = applyOptsSchema.parse(optsInput ?? {});

  // Re-derive everything from the live DB — the client only chose the rules and
  // the overwrite toggle, never the writes themselves.
  const { signs, rooms, mapIdByKey, mapMetaByKey } = await loadData();

  // A rule pointing at a disabled/absent map would create rooms on a map key with
  // no id — refuse rather than write half a batch.
  const badKeys = invalidRuleKeys(rules, mapIdByKey);
  if (badKeys.length > 0) throw new Error("unknown-floor-map-key");

  const resolver = buildFloorMapResolver(rules);
  // includeOverwrite: treat already-placed signs as eligible by clearing their
  // placement in-memory before classifying, so they flow into link/create. The
  // real placement is only cleared by the link updateMany below (audited).
  const effectiveSigns = opts.includeOverwrite
    ? signs.map((s) => ({ ...s, locationId: null, mapX: null, mapY: null }))
    : signs;
  const plan = classifyAutoPin(effectiveSigns, rooms, resolver);

  const keyToId = (k: string): number | undefined => mapIdByKey.get(k);

  // Prior state of every sign we're about to touch, for a reversible audit trail.
  const affectedIds = [
    ...plan.links.flatMap((g) => g.signIds),
    ...plan.creates.flatMap((g) => g.signIds),
  ];
  const prior = affectedIds.length
    ? await prisma.sign.findMany({
        where: { id: { in: affectedIds } },
        select: { id: true, locationId: true, mapX: true, mapY: true, mapFloor: true },
      })
    : [];

  let created = 0;
  let rehomed = 0;
  let linked = 0;
  let skipped = 0;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create missing rooms (single non-range codes) on their inferred map.
      //    building/floor/zoneId come from the map's zone (createRoom parity) —
      //    null zone for the zone-less DC34 maps, correct if reused on a zoned one.
      const createData: Prisma.LocationCreateManyInput[] = [];
      for (const g of plan.creates) {
        const meta = mapMetaByKey.get(g.floorMapKey);
        if (meta === undefined) {
          skipped += 1;
          continue;
        }
        createData.push({
          locationCode: g.code,
          building: meta.building,
          floor: meta.floor,
          zoneId: meta.zoneId,
          floorMapId: meta.id,
        });
      }
      if (createData.length > 0) {
        const res = await tx.location.createMany({
          data: createData,
          skipDuplicates: true,
        });
        created = res.count;
      }

      // 2. Resolve code → id for the create groups (createMany returns no ids and
      //    skips pre-existing codes; this covers both).
      const createCodes = plan.creates.map((g) => g.code);
      const createdRooms = createCodes.length
        ? await tx.location.findMany({
            where: { locationCode: { in: createCodes } },
            select: { id: true, locationCode: true },
          })
        : [];
      const idByCode = new Map(createdRooms.map((r) => [r.locationCode, r.id]));

      // 3. Re-home orphaned matched rooms onto their map (batched per map).
      const rehomeByMap = new Map<number, number[]>();
      for (const r of plan.rehome) {
        const floorMapId = keyToId(r.floorMapKey);
        if (floorMapId === undefined) continue;
        const list = rehomeByMap.get(floorMapId) ?? [];
        list.push(r.roomId);
        rehomeByMap.set(floorMapId, list);
      }
      for (const [floorMapId, roomIds] of rehomeByMap) {
        const res = await tx.location.updateMany({
          where: { id: { in: roomIds }, floorMapId: null },
          data: { floorMapId },
        });
        rehomed += res.count;
      }

      // 4. Link signs to their room (existing links + newly created). Clearing
      //    the override lets the room's reusable pin resolve.
      const linkGroups: { roomId: number; signIds: number[] }[] = [
        ...plan.links.map((g) => ({ roomId: g.roomId, signIds: g.signIds })),
        ...plan.creates
          .map((g) => {
            const roomId = idByCode.get(g.code);
            return roomId === undefined ? null : { roomId, signIds: g.signIds };
          })
          .filter((g): g is { roomId: number; signIds: number[] } => g !== null),
      ];
      // Re-assert the eligibility filter INSIDE the transaction. The classifier's
      // exclusion ran on the pre-transaction snapshot; this guard closes the TOCTOU
      // window where a sign got hand-placed (or picked up by a concurrent run) in
      // between, so the default path can never clobber a placement it didn't see.
      // (It also makes re-runs a natural no-op.) Dropped for the opt-in overwrite
      // path, whose whole purpose is to re-pin already-placed signs.
      const eligibility: Prisma.SignWhereInput = opts.includeOverwrite
        ? {}
        : { locationId: null, mapX: null, mapY: null };
      for (const g of linkGroups) {
        for (const ids of chunk(g.signIds, CHUNK)) {
          const res = await tx.sign.updateMany({
            where: { id: { in: ids }, ...eligibility },
            data: { locationId: g.roomId, mapX: null, mapY: null, mapFloor: null },
          });
          linked += res.count;
        }
      }

      return { created, rehomed, linked, skipped };
    }, { timeout: 30_000 });

    created = result.created;
    rehomed = result.rehomed;
    linked = result.linked;
    skipped = result.skipped;
  } catch (err) {
    logError("signs.autopin.apply", err);
    throw new Error("apply-failed");
  }

  if (linked > 0 || created > 0 || rehomed > 0) revalidatePath("/signs");

  if (linked > 0 || created > 0 || rehomed > 0) {
    // Reversible payload: which signs were (re)linked and their prior placement,
    // so a bad batch can be undone. Bounded so the audit row can't blow up.
    const priorTouched = prior.filter(
      (p) => p.locationId !== null || p.mapX !== null || p.mapY !== null,
    );
    const reversal = {
      linkedSignIds: affectedIds.slice(0, 2000),
      truncated: affectedIds.length > 2000,
      priorPlacements: priorTouched.slice(0, 2000),
    };
    await recordAudit({
      action: "sign.bulk_autopin",
      actorId: session.user.id,
      actorEmail: session.user.email,
      detail:
        `Auto-pin: linked ${linked} sign(s) to rooms — ${created} created, ` +
        `${rehomed} re-homed${skipped > 0 ? `, ${skipped} skipped (no map)` : ""}` +
        `${opts.includeOverwrite ? " [overwrite ON]" : ""}. ` +
        JSON.stringify(reversal),
    });
  }

  return { created, rehomed, linked, skipped };
}
