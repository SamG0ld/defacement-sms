"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  signMaterialCountsFromSummary,
  SIGN_MATERIAL_TYPE_NAMES,
} from "@/lib/equipment";
import { computePrintSummary } from "@/lib/print-summary";
import { requireRole } from "@/lib/rbac";

function fail(year: number, message: string): never {
  redirect(`/inventory?year=${year}&error=${encodeURIComponent(message)}`);
}

// Bound args reach these actions from a publicly-callable endpoint, so don't
// trust them blindly — a bad id just misses, but guard for consistency.
function requireValidId(typeId: number, year: number): void {
  if (!Number.isInteger(typeId) || typeId <= 0) fail(year, "Invalid item.");
}

// name + category share the same shape across add/edit. Category is free text
// (the form offers a <select>, but the DB stores a label; lib/equipment.ts
// classifyKind maps it to a section). Empty category -> null -> consumable.
const itemSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.string().trim().max(100).nullable(),
});

function readItem(formData: FormData) {
  return itemSchema.safeParse({
    name: formData.get("name"),
    category: (String(formData.get("category") ?? "").trim() || null) as
      | string
      | null,
  });
}

export async function addEquipmentType(formData: FormData): Promise<void> {
  const session = await requireRole("lead");

  const year =
    Number.parseInt(String(formData.get("year") ?? ""), 10) ||
    new Date().getFullYear();

  const parsed = readItem(formData);
  if (!parsed.success) fail(year, "Enter a name (category optional).");

  try {
    await prisma.equipmentType.create({
      data: { name: parsed.data.name, category: parsed.data.category },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      fail(year, `"${parsed.data.name}" already exists.`);
    }
    throw err;
  }

  await recordAudit({
    action: "equipment.add",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Added "${parsed.data.name}"${parsed.data.category ? ` (${parsed.data.category})` : ""}`,
  });

  revalidatePath("/inventory");
}

export async function updateEquipmentType(
  typeId: number,
  year: number,
  formData: FormData,
): Promise<void> {
  const session = await requireRole("lead");
  requireValidId(typeId, year);

  const parsed = readItem(formData);
  if (!parsed.success) fail(year, "Enter a name (category optional).");

  try {
    await prisma.equipmentType.update({
      where: { id: typeId },
      data: { name: parsed.data.name, category: parsed.data.category },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      fail(year, `"${parsed.data.name}" already exists.`);
    }
    console.error("updateEquipmentType failed", err);
    fail(year, "Could not update the item. Try again.");
  }

  await recordAudit({
    action: "equipment.update",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Renamed/recategorized item #${typeId} to "${parsed.data.name}"${parsed.data.category ? ` (${parsed.data.category})` : ""}`,
  });

  revalidatePath("/inventory");
}

// No FormData param: this is invoked as a <form action> via .bind(null, typeId,
// year), so the action is fully argument-driven and the trailing FormData the
// runtime passes is simply ignored.
export async function deleteEquipmentType(
  typeId: number,
  year: number,
): Promise<void> {
  const session = await requireRole("lead");
  requireValidId(typeId, year);

  // History guard: deleting an EquipmentType cascades its EquipmentInventory
  // rows (schema onDelete: Cascade). Refuse if ANY count rows exist so saved
  // counts / year-over-year history can never be silently wiped — the item has
  // to be emptied first. Items with no counts (mis-adds, retired consumables)
  // delete freely.
  const type = await prisma.equipmentType.findUnique({
    where: { id: typeId },
    select: { name: true, _count: { select: { inventory: true } } },
  });
  if (!type) fail(year, "Item not found.");
  if (type._count.inventory > 0) {
    fail(
      year,
      `"${type.name}" has saved counts/history — clear its counts before deleting.`,
    );
  }

  try {
    await prisma.equipmentType.delete({ where: { id: typeId } });
  } catch (err) {
    console.error("deleteEquipmentType failed", err);
    fail(year, "Could not delete the item. Try again.");
  }

  await recordAudit({
    action: "equipment.delete",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Deleted item "${type.name}" (#${typeId})`,
  });

  revalidatePath("/inventory");
}

export async function upsertInventory(
  typeId: number,
  year: number,
  formData: FormData,
): Promise<void> {
  await requireRole("lead");
  requireValidId(typeId, year);

  // The action is callable directly, so don't trust the bound year — keep it in
  // a sane range (matches the page's year dropdown) instead of letting a caller
  // create rows for year 999999999.
  const current = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2015 || year > current + 2) {
    fail(current, "Invalid year.");
  }

  // Only persist the count fields actually present in this form. The consumable
  // form omits countEndOfCon, so a blanket write would zero it on every save;
  // skipping absent keys leaves them untouched on update (and defaulted on
  // create). notes is length-bounded like sign notes.
  const data: {
    countStartOfCon?: number;
    countEndOfCon?: number;
    countOrdered?: number;
    countReceived?: number;
    notes?: string | null;
  } = {};
  const countKeys = [
    "countStartOfCon",
    "countEndOfCon",
    "countOrdered",
    "countReceived",
  ] as const;
  for (const key of countKeys) {
    const raw = formData.get(key);
    if (raw === null) continue; // field not rendered in this form
    const n = Number.parseInt(String(raw), 10);
    data[key] = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const notesRaw = formData.get("notes");
  if (notesRaw !== null) {
    data.notes = String(notesRaw).trim().slice(0, 2000) || null;
  }

  try {
    await prisma.equipmentInventory.upsert({
      where: { equipmentTypeId_year: { equipmentTypeId: typeId, year } },
      create: { equipmentTypeId: typeId, year, ...data },
      update: data,
    });
  } catch (err) {
    console.error("upsertInventory failed", err);
    fail(year, "Could not save inventory. Try again.");
  }

  // Note: routine per-save count edits are intentionally NOT audit-logged —
  // that would flood the log. Structural changes (add/update/delete of items)
  // above are the audit-worthy events.
  revalidatePath("/inventory");
}

// Snapshot the current sign list's print-summary material totals into the
// year-over-year history for `year` (the six "Sign Material" rows). Lets a
// completed con's totals be recorded straight from the imported signs instead
// of being hand-typed — and persists them so they survive the working set being
// replaced by the next con's data. Bound with the year for a <form action>.
export async function recordSignMaterialHistory(year: number): Promise<void> {
  const session = await requireRole("lead");
  const current = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2015 || year > current + 2) {
    fail(current, "Invalid year.");
  }

  const sizeGroups = await prisma.sign.groupBy({
    by: ["size", "doubleSided"],
    _sum: { quantity: true },
  });
  const summary = computePrintSummary(
    sizeGroups.map((g) => ({
      size: g.size,
      doubleSided: g.doubleSided,
      quantity: g._sum.quantity ?? 0,
    })),
  );
  const counts = signMaterialCountsFromSummary(summary);

  const types = await prisma.equipmentType.findMany({
    where: { name: { in: [...SIGN_MATERIAL_TYPE_NAMES] } },
    select: { id: true, name: true },
  });
  if (types.length === 0) {
    fail(year, "Sign-material rows are missing — run the equipment seed first.");
  }

  try {
    await prisma.$transaction(
      types.map((t) =>
        prisma.equipmentInventory.upsert({
          where: { equipmentTypeId_year: { equipmentTypeId: t.id, year } },
          create: {
            equipmentTypeId: t.id,
            year,
            countEndOfCon: counts[t.name] ?? 0,
          },
          update: { countEndOfCon: counts[t.name] ?? 0 },
        }),
      ),
    );
  } catch (err) {
    console.error("recordSignMaterialHistory failed", err);
    fail(year, "Could not record sign totals. Try again.");
  }

  await recordAudit({
    action: "equipment.record_sign_history",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Recorded sign-material totals to ${year} from ${summary.totalSigns} signs`,
  });

  revalidatePath("/inventory");
}
