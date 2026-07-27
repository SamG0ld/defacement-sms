"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { logError } from "@/lib/log";
import { Prisma } from "@/app/generated/prisma/client";

import { DEPLOYMENT_SLOTS } from "../_lib";
import { signDedupKey } from "../import/_map";
import { signSchema, toSignData } from "../_form-shared";
import { SPECIALTY_TYPES, specialtyType } from "./_taxonomy";
import { MAX_SPECIALTY_ROWS } from "./_limits";
import { softDupKey, detectSoftDuplicates } from "./_dedup";

// Bulk intake for externally-produced install items (floor/wall graphics,
// vinyls, banners, sticker walls, selfie banners, venue maps). Mirrors the CSV
// importer's preview -> execute pair: preview classifies and flags, execute
// re-derives everything against the live DB and writes atomically. Rows land
// in the M14 external categories, so the delivery -> handoff -> installed
// lifecycle picks them up with no further wiring.

// What the intake grid submits per row. Everything else on Sign is derived
// (category/tag/signType from the taxonomy) or defaulted (external items are
// not printable, need no easel, carry no cost at intake).
export type SpecialtyRowInput = {
  typeKey: string;
  itemId: string;
  signText: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  zoneId: number | null;
  placementArea: string | null;
  deploymentSlot: string | null;
  notes: string | null;
};

const slotValues = DEPLOYMENT_SLOTS.map((s) => s.value) as [string, ...string[]];

// Row bounds reuse signSchema's ceilings (same columns, same DoS rationale);
// deploymentSlot is allowlisted like the list-filter guard (#54). Strings are
// trimmed HERE (the single-sign path trims in readSignForm) so the duplicate
// key never differs from a clean re-entry by stray whitespace.
const rowSchema = z.object({
  typeKey: z
    .string()
    .refine((k) => specialtyType(k) != null, "Unknown item type"),
  itemId: z.string().trim().min(1, "Item ID is required").max(100),
  signText: z.string().trim().min(1, "Name/text is required").max(500),
  size: z.string().trim().min(1, "Size is required").max(50),
  quantity: z.number().int().min(1).max(999),
  doubleSided: z.boolean(),
  zoneId: z.number().int().positive().nullable(),
  placementArea: z.string().trim().max(300).nullable(),
  deploymentSlot: z.enum(slotValues).nullable(),
  notes: z.string().trim().max(5000).nullable(),
});

export type SpecialtyRowStatus = "valid" | "invalid" | "duplicate";

export type SpecialtyPreviewRow = {
  index: number;
  input: SpecialtyRowInput;
  category: string | null;
  tagName: string | null;
  status: SpecialtyRowStatus;
  error: string | null;
  // Non-blocking heads-up (e.g. item ID already in use by a different sign) —
  // the row still writes; the review screen renders it amber.
  warning: string | null;
};

export type SpecialtyPreview = {
  rows: SpecialtyPreviewRow[];
  counts: { valid: number; invalid: number; duplicate: number; total: number };
  error: string | null;
};

export type SpecialtyResult = {
  created: number;
  skipped: number;
  failed: number;
};

// Duplicate identity comes from the shared signDedupKey (import/_map.ts) — the SAME
// function the CSV importer keys on — so both intake surfaces agree on what "already
// entered" means. That is deliberately an import, not a local copy: a local copy is
// exactly what drifted before, leaving specialty without the room-code normalization
// (so "W204, W205" and "W204-W205" were two identities and one booth got two Sign
// rows) and without the JSON-tuple shape that stops a key realigning at field
// boundaries.

// Full signSchema shape for a row: taxonomy fills the derived fields, intake
// defaults the rest. Funnels through the SAME schema + toSignData the single
// create action uses, so bounds and Decimal math can't drift.
function fullSignShape(row: z.infer<typeof rowSchema>) {
  const t = specialtyType(row.typeKey)!;
  return {
    itemId: row.itemId,
    signText: row.signText,
    // Specialty intake never carries a distinct back face; be explicit rather than
    // relying on the schema's optional default.
    backText: null,
    signType: t.label,
    size: row.size,
    quantity: row.quantity,
    doubleSided: row.doubleSided,
    needsEasel: false,
    category: t.category,
    printable: false,
    requestor: null,
    requestorEmail: null,
    costPerUnit: null,
    zoneId: row.zoneId,
    placementArea: row.placementArea,
    exactDestination: null,
    deploymentPriority: 2,
    deploymentSlot: row.deploymentSlot,
    notes: row.notes,
  };
}

type ClassifiedRow = {
  index: number;
  input: SpecialtyRowInput;
  parsed: z.infer<typeof rowSchema> | null;
  category: string | null;
  tagName: string | null;
  status: SpecialtyRowStatus;
  error: string | null;
  warning: string | null;
};

async function classify(rows: SpecialtyRowInput[]): Promise<ClassifiedRow[]> {
  const [zones, existing] = await Promise.all([
    prisma.zone.findMany({
      where: { isActive: true },
      select: { id: true },
    }),
    prisma.sign.findMany({
      select: { itemId: true, signText: true, size: true },
    }),
  ]);
  const activeZoneIds = new Set(zones.map((zn) => zn.id));
  const existingKeys = new Set(
    existing.map((s) => signDedupKey(s.itemId, s.signText, s.size)),
  );
  const existingItemIds = new Set(existing.map((s) => s.itemId));
  // Advisory-only soft-dup hints (same text + size as another row / an existing
  // sign, regardless of itemId). Never affects a row's status — a copy still
  // writes; the reviewer just gets a heads-up. Computed once for the batch.
  const existingSoftKeys = new Set(
    existing.map((s) => softDupKey(s.signText, s.size)),
  );
  const softHints = detectSoftDuplicates(
    rows.map((r) => ({ signText: r.signText, size: r.size })),
    existingSoftKeys,
  );

  // Duplicates within the submitted batch itself count too — the second
  // occurrence is flagged, the first stays valid.
  const batchKeys = new Set<string>();
  const batchItemIds = new Set<string>();

  return rows.map((input, index) => {
    const invalid = (error: string, parsed: z.infer<typeof rowSchema> | null, t?: { category: string; tagName: string }) => ({
      index,
      input,
      parsed,
      category: t?.category ?? null,
      tagName: t?.tagName ?? null,
      status: "invalid" as const,
      error,
      warning: null,
    });

    const parsed = rowSchema.safeParse(input);
    if (!parsed.success) {
      return invalid(parsed.error.issues[0]?.message ?? "Invalid row", null);
    }
    const t = specialtyType(parsed.data.typeKey)!;
    if (parsed.data.zoneId != null && !activeZoneIds.has(parsed.data.zoneId)) {
      return invalid("Selected zone is not available.", parsed.data, t);
    }
    // Guard against preview/execute schema drift: the row must also pass the
    // full signSchema the write path parses with (today the bounds agree; this
    // keeps a future signSchema tightening from failing the batch mid-transaction).
    const full = signSchema.safeParse(fullSignShape(parsed.data));
    if (!full.success) {
      return invalid(full.error.issues[0]?.message ?? "Invalid row", parsed.data, t);
    }

    const key = signDedupKey(
      parsed.data.itemId,
      parsed.data.signText,
      parsed.data.size,
    );
    const isDup = existingKeys.has(key) || batchKeys.has(key);
    // Same tracking ID on a different item (auto-EXT collision from a second
    // open session, or a typo): not a duplicate, but worth a heads-up.
    const idTaken =
      !isDup &&
      (existingItemIds.has(parsed.data.itemId) ||
        batchItemIds.has(parsed.data.itemId));
    batchKeys.add(key);
    batchItemIds.add(parsed.data.itemId);
    // Non-blocking warnings stack: an in-use itemId and a soft text+size dup are
    // independent heads-ups; a hard duplicate already carries its own error.
    const warnings: string[] = [];
    if (idTaken) {
      warnings.push(
        "Item ID is already used by a different sign — edit it to keep IDs unique.",
      );
    }
    if (!isDup && softHints[index]) warnings.push(softHints[index]!);
    return {
      index,
      input,
      parsed: parsed.data,
      category: t.category,
      tagName: t.tagName,
      status: isDup ? ("duplicate" as const) : ("valid" as const),
      // "matching", not "same": the shared key normalizes room-code formatting, so
      // "W204-W205" matches an existing "W204, W205" even though they read differently.
      error: isDup ? "Already exists (matching ID, text, and size) — will be skipped." : null,
      warning: warnings.length > 0 ? warnings.join(" · ") : null,
    };
  });
}

function toPreview(classified: ClassifiedRow[], error: string | null): SpecialtyPreview {
  const counts = { valid: 0, invalid: 0, duplicate: 0, total: classified.length };
  for (const r of classified) counts[r.status] += 1;
  return {
    rows: classified.map((r) => ({
      index: r.index,
      input: r.input,
      category: r.category,
      tagName: r.tagName,
      status: r.status,
      error: r.error,
      warning: r.warning,
    })),
    counts,
    error,
  };
}

export async function previewSpecialtyBatch(
  rows: SpecialtyRowInput[],
): Promise<SpecialtyPreview> {
  const session = await requireRole("lead");

  const { success } = await checkActionRateLimit(`specialty:${session.user.id}`);
  if (!success) {
    return toPreview([], "Too many attempts. Wait a minute and try again.");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return toPreview([], "No rows to review.");
  }
  if (rows.length > MAX_SPECIALTY_ROWS) {
    return toPreview([], `Too many rows (max ${MAX_SPECIALTY_ROWS} per batch).`);
  }

  return toPreview(await classify(rows), null);
}

export async function executeSpecialtyBatch(
  rows: SpecialtyRowInput[],
): Promise<SpecialtyResult> {
  const session = await requireRole("lead");

  const { success } = await checkActionRateLimit(`specialty:${session.user.id}`);
  if (!success) throw new Error("rate-limited");
  if (!Array.isArray(rows) || rows.length === 0) {
    return { created: 0, skipped: 0, failed: 0 };
  }
  if (rows.length > MAX_SPECIALTY_ROWS) throw new Error("too-many-rows");

  // Re-derived against the live DB, like executeImport: duplicate/zone state
  // reflects execute time, not preview time. Invalid AND duplicate rows are
  // skipped (design decision 2026-07-07: warn-and-skip, never block the rest).
  const classified = await classify(rows);
  const toInsert = classified.filter((r) => r.status === "valid");
  const skipped = classified.length - toInsert.length;

  let created = 0;
  let failed = 0;

  if (toInsert.length > 0) {
    const enteredBy = session.user.email ?? session.user.id;
    try {
      created = await prisma.$transaction(async (tx) => {
        // Taxonomy tags are upserted by slug so intake has no seed dependency.
        // Slugs come from SPECIALTY_TYPES (compile-time constants), never from
        // the request, so this cannot create arbitrary tags.
        const neededKeys = new Set(toInsert.map((r) => r.parsed!.typeKey));
        const tagIdByKey = new Map<string, number>();
        for (const key of neededKeys) {
          const t = SPECIALTY_TYPES.find((s) => s.key === key)!;
          const tag = await tx.signTag.upsert({
            where: { slug: t.tagSlug },
            update: {},
            create: { slug: t.tagSlug, name: t.tagName },
            select: { id: true },
          });
          tagIdByKey.set(key, tag.id);
        }

        const signData: Prisma.SignCreateManyInput[] = toInsert.map((r) => ({
          ...toSignData(signSchema.parse(fullSignShape(r.parsed!))),
          status: "pending",
        }));
        const createdRows = await tx.sign.createManyAndReturn({
          data: signData,
          select: { id: true },
        });

        const tagData: Prisma.SignTagAssignmentCreateManyInput[] = [];
        const historyData: Prisma.StatusHistoryCreateManyInput[] = [];
        createdRows.forEach((c, i) => {
          const tagId = tagIdByKey.get(toInsert[i].parsed!.typeKey);
          if (tagId !== undefined) tagData.push({ signId: c.id, tagId });
          historyData.push({
            signId: c.id,
            oldStatus: null,
            newStatus: "pending",
            changedBy: enteredBy,
            notes: "Added via specialty intake",
          });
        });

        await tx.statusHistory.createMany({ data: historyData });
        if (tagData.length > 0) {
          await tx.signTagAssignment.createMany({
            data: tagData,
            skipDuplicates: true,
          });
        }
        return createdRows.length;
      });
    } catch (err) {
      logError("signs.specialty-intake", err);
      failed = toInsert.length;
    }
  }

  if (created > 0) {
    revalidatePath("/signs");
    revalidatePath("/inventory");
  }

  await recordAudit({
    action: "signs.specialty-intake",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Specialty intake: created ${created} item${created === 1 ? "" : "s"}${
      skipped > 0 ? `, skipped ${skipped}` : ""
    }${failed > 0 ? `, ${failed} failed` : ""}`,
  });

  return { created, skipped, failed };
}
