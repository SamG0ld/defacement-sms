"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireRole, requireSession } from "@/lib/rbac";
import { Prisma } from "@/app/generated/prisma/client";
import type { SignStatus } from "@/app/generated/prisma/client";

import { SIGN_STATUSES, stampsForStatus } from "./_lib";

// Surface failures via ?error= on the originating page (same server-only pattern
// as /users). redirect() throws, so these never return.
function failList(message: string): never {
  redirect(`/signs?error=${encodeURIComponent(message)}`);
}
function failDetail(signId: number, message: string): never {
  redirect(`/signs/${signId}?error=${encodeURIComponent(message)}`);
}

// ---------------------------------------------------------------------------
// Status workflow — the ONLY single-sign path that mutates Sign.status (bulk
// changes go through bulk-actions.ts). Any active user may set a sign to any
// other status directly (the step-wise workflow gate was dropped so floor staff
// can jump e.g. pending → deployed in one click); every change is recorded in
// StatusHistory inside one transaction.
// ---------------------------------------------------------------------------
export async function updateSignStatus(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();

  const next = formData.get("status");
  const notesRaw = formData.get("notes");
  const notes =
    typeof notesRaw === "string" && notesRaw.trim() !== ""
      ? notesRaw.trim()
      : null;
  // Any active user can reach this action; bound the note so it can't be used
  // to write multi-MB rows that then re-render on every detail-page load.
  if (notes && notes.length > 2000) {
    failDetail(signId, "Note is too long (max 2000 characters).");
  }

  if (
    typeof next !== "string" ||
    !SIGN_STATUSES.includes(next as SignStatus)
  ) {
    failDetail(signId, "Invalid status.");
  }
  const newStatus = next as SignStatus;

  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true, status: true },
  });
  if (!sign) failList("Sign not found.");

  if (sign.status === newStatus) {
    failDetail(signId, "Sign is already in that status.");
  }

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();

  // Delivery/deployment stamps follow the target status (shared with the bulk
  // path). See stampsForStatus in _lib.ts for the rules.
  const stamps = stampsForStatus(newStatus, changedBy, now);

  await prisma.$transaction([
    prisma.sign.update({
      where: { id: signId },
      data: { status: newStatus, ...stamps },
    }),
    prisma.statusHistory.create({
      data: {
        signId,
        oldStatus: sign.status,
        newStatus,
        changedBy,
        notes,
      },
    }),
  ]);

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// ---------------------------------------------------------------------------
// Hardware collection — an operational flag (like status), open to any active
// user. Tracks whether the gear a sign needs (easel / meterboard stand) has been
// gathered; the UI only surfaces it for signs that need hardware. Toggling does
// not write StatusHistory (it isn't a status); updatedAt records the change.
// ---------------------------------------------------------------------------
export async function setHardwareCollected(
  signId: number,
  formData: FormData,
): Promise<void> {
  await requireSession();

  const collected = formData.get("collected") === "1";
  const exists = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true },
  });
  if (!exists) failList("Sign not found.");

  await prisma.sign
    .update({ where: { id: signId }, data: { equipmentCheckedOut: collected } })
    .catch(() => failDetail(signId, "Could not update hardware status."));

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// ---------------------------------------------------------------------------
// Create / edit / delete — lead+ only.
// ---------------------------------------------------------------------------

// Build a normalized, typed object out of the form, converting "" → null for
// optionals and checkbox presence → boolean, BEFORE zod asserts shape.
function readSignForm(formData: FormData) {
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

  return {
    itemId: get("itemId"),
    signText: get("signText"),
    signType: get("signType"),
    size: get("size"),
    quantity,
    doubleSided: formData.get("doubleSided") != null,
    needsEasel: formData.get("needsEasel") != null,
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
const signSchema = z.object({
  itemId: z.string().min(1, "Item ID is required").max(100),
  signText: z.string().min(1, "Sign text is required").max(500),
  signType: z.string().min(1, "Sign type is required").max(100),
  size: z.string().min(1, "Size is required").max(50),
  quantity: z.number().int().min(1).max(999),
  doubleSided: z.boolean(),
  needsEasel: z.boolean(),
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
function toSignData(d: z.infer<typeof signSchema>) {
  // Money math in Decimal, not JS float, so totalCost is exact before it hits
  // the Decimal(10,2) column.
  const totalCost =
    d.costPerUnit != null
      ? new Prisma.Decimal(d.costPerUnit).mul(d.quantity)
      : null;
  return {
    itemId: d.itemId,
    signText: d.signText,
    signType: d.signType,
    size: d.size,
    quantity: d.quantity,
    doubleSided: d.doubleSided,
    needsEasel: d.needsEasel,
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
async function checkRefs(
  zoneId: number | null,
  tagIds: number[],
): Promise<string | null> {
  if (zoneId != null) {
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
  }
  return null;
}

export async function createSign(formData: FormData): Promise<void> {
  await requireRole("lead");

  const raw = readSignForm(formData);
  const parsed = signSchema.safeParse(raw);
  if (!parsed.success) {
    failList(parsed.error.issues[0]?.message ?? "Invalid sign details.");
  }

  const refError = await checkRefs(parsed.data.zoneId, raw.tagIds);
  if (refError) failList(refError);

  let newId: number;
  try {
    const created = await prisma.sign.create({
      data: {
        ...toSignData(parsed.data),
        tagAssignments:
          raw.tagIds.length > 0
            ? { create: raw.tagIds.map((tagId) => ({ tagId })) }
            : undefined,
      },
      select: { id: true },
    });
    newId = created.id;
  } catch (err) {
    console.error("createSign failed", err);
    failList("Could not create the sign. Check the details and try again.");
  }

  revalidatePath("/signs");
  redirect(`/signs/${newId}`);
}

export async function updateSign(
  signId: number,
  formData: FormData,
): Promise<void> {
  await requireRole("lead");

  const raw = readSignForm(formData);
  const parsed = signSchema.safeParse(raw);
  if (!parsed.success) {
    failDetail(
      signId,
      parsed.error.issues[0]?.message ?? "Invalid sign details.",
    );
  }

  const exists = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true },
  });
  if (!exists) failList("Sign not found.");

  const refError = await checkRefs(parsed.data.zoneId, raw.tagIds);
  if (refError) failDetail(signId, refError);

  // Replace tag assignments wholesale (delete + recreate) to match the
  // submitted checkbox set. Status is intentionally NOT touched here — it only
  // changes through updateSignStatus, which records history.
  try {
    await prisma.$transaction([
      prisma.sign.update({
        where: { id: signId },
        data: toSignData(parsed.data),
      }),
      prisma.signTagAssignment.deleteMany({ where: { signId } }),
      ...(raw.tagIds.length > 0
        ? [
            prisma.signTagAssignment.createMany({
              data: raw.tagIds.map((tagId) => ({ signId, tagId })),
            }),
          ]
        : []),
    ]);
  } catch (err) {
    console.error("updateSign failed", err);
    failDetail(signId, "Could not save changes. Check the details and try again.");
  }

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
  redirect(`/signs/${signId}`);
}

export async function deleteSign(signId: number): Promise<void> {
  await requireRole("lead");

  // Cascade (schema onDelete) clears status_history + tag assignments.
  await prisma.sign.delete({ where: { id: signId } }).catch(() => {
    failList("Could not delete the sign.");
  });

  revalidatePath("/signs");
  redirect("/signs");
}
