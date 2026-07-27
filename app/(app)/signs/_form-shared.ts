// Shared form-shape helpers for the single-sign create/edit actions and the
// specialty bulk-intake action. Moved verbatim out of actions.ts ("use server"
// files may only export async functions, so shared sync helpers must live
// outside it). Server-only by usage: imports prisma.

import { z } from "zod";

import { prisma } from "@/lib/db";
import { formatForKey } from "@/lib/sign-format";
import { SYSTEM_TAG_SLUG_LIST } from "@/lib/tags";
import { Prisma } from "@/app/generated/prisma/client";

import { SIGN_CATEGORIES } from "./_lib";

// Build a normalized, typed object out of the form, converting "" → null for
// optionals and checkbox presence → boolean, BEFORE zod asserts shape.
//
// Format is the single source of truth: when the form posts a known Format key,
// size / signType / category / doubleSided are HARD-derived from the canonical
// table (lib/sign-format.ts) and the raw fields are ignored — one choice can't
// drift into three out-of-sync fields. needsEasel is only DEFAULTED by the format
// (client-side on pick); it stays an independent checkbox here so a bare-easel
// override survives. When no known format is posted (the "advanced / custom"
// path), the raw size/type/category/double fields are used verbatim.
export function readSignForm(formData: FormData) {
  const get = (k: string): string => {
    const v = formData.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const optStr = (k: string): string | null => {
    const v = get(k);
    return v === "" ? null : v;
  };
  const num = (raw: string): number | null => {
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const quantity = Math.max(1, Math.trunc(num(get("quantity")) ?? 1));
  const deploymentPriority = Math.trunc(num(get("deploymentPriority")) ?? 2);
  const costPerUnit = num(get("costPerUnit"));

  // A known Format key drives the physical shape; unknown/"" falls through to the
  // raw advanced fields.
  const fmt = formatForKey(get("format"));

  const doubleSided = fmt ? fmt.doubleSided : formData.get("doubleSided") != null;

  return {
    itemId: get("itemId"),
    signText: get("signText"),
    // Distinct back-face text only applies to a double-sided board; drop it
    // otherwise so toggling double-sided off can't leave orphaned back text.
    backText: doubleSided ? optStr("backText") : null,
    signType: fmt ? fmt.signType : get("signType"),
    size: fmt ? fmt.size : get("size"),
    quantity,
    doubleSided,
    needsEasel: formData.get("needsEasel") != null,
    category: fmt ? fmt.category : get("category"),
    printable: formData.get("printable") != null,
    requestor: optStr("requestor"),
    requestorEmail: optStr("requestorEmail"),
    costPerUnit,
    zoneId: (() => {
      const z = num(get("zoneId"));
      return z != null && Number.isInteger(z) && z > 0 ? z : null;
    })(),
    placementArea: optStr("placementArea"),
    exactDestination: optStr("exactDestination"),
    deploymentPriority: deploymentPriority >= 1 ? deploymentPriority : 2,
    deploymentSlot: optStr("deploymentSlot"),
    notes: optStr("notes"),
    tagIds: formData
      .getAll("tags")
      .map((t) => Number(t))
      .filter((n) => Number.isInteger(n) && n > 0),
  };
}

// Upper bounds keep text columns from being used as a storage/render DoS and
// keep cost × quantity inside the Decimal(10,2) column (max ~99,999,999.99):
// 99,999.99 × 999 ≈ 99.9M, safely under the ceiling.
export const signSchema = z.object({
  itemId: z.string().min(1, "Item ID is required").max(100),
  signText: z.string().min(1, "Sign text is required").max(500),
  // Optional (not just nullable) so callers that never set it — e.g. specialty
  // bulk intake's fullSignShape — still validate; matches rowSchema's backText in
  // import/_map.ts. readSignForm always provides it (string | null).
  backText: z.string().max(500).nullable().optional(),
  signType: z.string().min(1, "Sign type is required").max(100),
  size: z.string().min(1, "Size is required").max(50),
  quantity: z.number().int().min(1).max(999),
  doubleSided: z.boolean(),
  needsEasel: z.boolean(),
  category: z.enum(SIGN_CATEGORIES),
  printable: z.boolean(),
  requestor: z.string().max(200).nullable(),
  requestorEmail: z
    .string()
    .email("Invalid requestor email")
    .max(320)
    .nullable(),
  costPerUnit: z.number().min(0).max(99999.99).nullable(),
  zoneId: z.number().int().positive().nullable(),
  placementArea: z.string().max(300).nullable(),
  exactDestination: z.string().max(300).nullable(),
  deploymentPriority: z.number().int().min(1).max(99),
  deploymentSlot: z.string().max(50).nullable(),
  notes: z.string().max(5000).nullable(),
});

// Shared shape → Prisma data (minus tags, which are relation rows).
export function toSignData(d: z.infer<typeof signSchema>) {
  // Money math in Decimal, not JS float, so totalCost is exact before it hits
  // the Decimal(10,2) column.
  const totalCost =
    d.costPerUnit != null
      ? new Prisma.Decimal(d.costPerUnit).mul(d.quantity)
      : null;
  return {
    itemId: d.itemId,
    signText: d.signText,
    backText: d.backText,
    signType: d.signType,
    size: d.size,
    quantity: d.quantity,
    doubleSided: d.doubleSided,
    needsEasel: d.needsEasel,
    category: d.category,
    printable: d.printable,
    requestor: d.requestor,
    requestorEmail: d.requestorEmail,
    costPerUnit: d.costPerUnit,
    totalCost,
    zoneId: d.zoneId,
    placementArea: d.placementArea,
    exactDestination: d.exactDestination,
    deploymentPriority: d.deploymentPriority,
    deploymentSlot: d.deploymentSlot,
    notes: d.notes,
  };
}

// Validate that a submitted zone exists + is active and that every submitted
// tag id is real, before writing — so a hand-edited form can't bypass the UI's
// active-zone filter or raise an unhandled FK error during the write.
//
// `existingZoneIdFromDb` is the zone the record ALREADY carries, and it must come
// from the row being updated — never from the submitted form (passing
// `parsed.data.zoneId` here would disable the active-zone check entirely). Edit
// passes it; create passes nothing. Re-submitting the existing zone unchanged is
// a no-op rather than a new assignment, so it is allowed even once that zone has
// been deactivated — otherwise a sign whose zone was retired mid-con could never
// be edited again. MOVING a sign onto an inactive zone is still refused.
export async function checkRefs(
  zoneId: number | null,
  tagIds: number[],
  existingZoneIdFromDb?: number | null,
): Promise<string | null> {
  if (zoneId != null && zoneId !== existingZoneIdFromDb) {
    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      select: { isActive: true },
    });
    if (!zone || !zone.isActive) return "Selected zone is not available.";
  }
  const unique = [...new Set(tagIds)];
  if (unique.length > 0) {
    const count = await prisma.signTag.count({ where: { id: { in: unique } } });
    if (count !== unique.length) {
      return "One or more selected tags no longer exist.";
    }
    // Reject system tags (e.g. `master-sheet`): they're hidden from the form, so a
    // submitted system-tag id is a hand-crafted request trying to pull a sign INTO
    // reconcile scope. Mirrors the guard on the bulk path (bulk-actions.ts readTagId)
    // — the delete-side is already protected by updateSign's notIn filter.
    const systemHit = await prisma.signTag.count({
      where: { id: { in: unique }, slug: { in: SYSTEM_TAG_SLUG_LIST } },
    });
    if (systemHit > 0) {
      return "That tag is managed by the system and can't be set here.";
    }
  }
  return null;
}
