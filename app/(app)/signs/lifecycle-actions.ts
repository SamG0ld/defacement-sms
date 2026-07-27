"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { requireSession } from "@/lib/rbac";
import { archivedRefusal } from "@/lib/sign-status-authz";
import { validateImageUpload } from "@/lib/image-upload";
import { deletePrivateImage } from "@/lib/blob-image";
import { uploadSignPhoto, type SignPhotoKind } from "@/lib/sign-photos";

import { isExternalCategory, stampsForStatus } from "./_lib";
import type { SignCategory } from "@/app/generated/prisma/enums";
import type { Prisma } from "@/app/generated/prisma/client";

// ---------------------------------------------------------------------------
// External-item lifecycle (Phase 2). union_installed / ops_map signs are produced
// off-site and installed by external actors (union crews / ops teams), so after we
// accept the print-shop delivery they go handed_off → installed instead of our own
// sorted → deployed flow. Each action mirrors updateSignStatus: it flips the
// status (reusing stampsForStatus for the who/when timestamps), records a
// descriptive StatusHistory row in the same transaction (which feeds /activity),
// and additionally persists the structured receiving/handoff detail + optional
// proof photo. Open to any active user (operational, like updateSignStatus).
// ---------------------------------------------------------------------------

function failList(message: string): never {
  redirect(`/signs?error=${encodeURIComponent(message)}`);
}
function failDetail(signId: number, message: string): never {
  redirect(`/signs/${signId}?error=${encodeURIComponent(message)}`);
}

// Generous per-actor backstop (60/min) — these actions are open to every
// active user, so a role gate alone is not a throttle.
async function assertMutateBudget(
  signId: number,
  userId: string,
): Promise<void> {
  const budget = await checkMutationRateLimit(userId);
  if (!budget.success) {
    failDetail(signId, "Too many changes at once — wait a minute and try again.");
  }
}

function photoErrorMessage(error: string): string {
  switch (error) {
    case "too_large":
      return "Photo is too large (max 10 MB).";
    case "unsupported_type":
      return "Photo must be a PNG, JPEG, or WebP image.";
    case "too_many_pixels":
      return "Photo resolution is too large (max 40 megapixels).";
    default:
      return "Photo could not be read.";
  }
}

// Read an optional "photo" file field: validate its magic bytes and upload to
// private Blob, returning the stored pathname (or null if none supplied). Uses the
// validated content type, never the browser-declared one. Throws a user-facing
// redirect on an invalid image. Uploaded before the DB write; if that write fails
// or is rejected, the caller deletes this blob via persistWithPhoto so a failed
// transaction can't orphan paid Blob storage (m17 #106).
async function uploadOptionalPhoto(
  signId: number,
  kind: SignPhotoKind,
  formData: FormData,
): Promise<string | null> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = validateImageUpload(bytes);
  if (!result.ok) failDetail(signId, photoErrorMessage(result.error));
  return uploadSignPhoto(signId, kind, bytes, result.image.contentType);
}

// Run a lifecycle status transaction that records a freshly-uploaded photo,
// deleting that blob if the transaction throws — a real DB error *or* a guard
// `redirect()` (which rolls the tx back). The photo is uploaded before the
// transaction, so without this a failed or rejected persist orphans paid Blob
// storage (m17 #106). Safe because these transactions never redirect on SUCCESS
// (callers revalidate + return), so every throw means the photo was not recorded.
async function persistWithPhoto(
  photoPath: string | null,
  work: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(work);
  } catch (err) {
    if (photoPath) await deletePrivateImage(photoPath);
    throw err;
  }
}

function optNotes(formData: FormData, max: number): string | null {
  const raw = formData.get("notes");
  const v = typeof raw === "string" ? raw.trim() : "";
  return v === "" ? null : v.slice(0, max);
}

// A soft-removed sign leaves `archived` ONLY through Restore — these actions are
// no exception (#269). The rule and its wording live in lib/sign-status-authz.ts
// so this fork and the generic status path tell the operator the same story; only
// the claim/rank/category parts of that policy are out of scope here (see the
// module header there). Called from BOTH the pre-tx early-exit below AND each
// action's locked in-tx re-read, since a sign can be removed between the two.
function refuseIfArchived(signId: number, status: string): void {
  const refusal = archivedRefusal(status);
  if (refusal) failDetail(signId, refusal.reason);
}

// Fetch a sign for a lifecycle action, asserting it's neither soft-removed nor
// outside the externally-installed classes (union_installed / ops_map). The
// dedicated UI only renders for these; guarding here keeps the
// receiving/handoff/install fields off a sign that doesn't belong on this fork
// (defense for a hand-crafted POST to a bound action).
async function loadExternalSign(
  signId: number,
): Promise<{ id: number; status: string; category: SignCategory }> {
  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true, status: true, category: true },
  });
  if (!sign) failList("Sign not found.");
  // Checked ahead of the category rule: "this sign was removed from the record"
  // is the more fundamental state, and is the actionable one for the operator.
  refuseIfArchived(signId, sign.status);
  if (!isExternalCategory(sign.category)) {
    failDetail(
      signId,
      "This step only applies to externally-installed items (banners / graphics / ops maps).",
    );
  }
  return sign;
}

// --- Accept delivery from the print shop --------------------------------------
const deliverySchema = z.object({
  receivedQty: z.number().int().min(0).max(100_000).nullable(),
  // Intentionally tighter than the 2000-char handoff/install notes: this is a
  // short condition phrase ("2 of 5 arrived creased"), not free narrative.
  condition: z.string().max(500).nullable(),
});

export async function recordDelivery(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  await assertMutateBudget(signId, session.user.id);

  const sign = await loadExternalSign(signId);
  // Don't let a back-button / double-submit re-record an earlier step after the
  // item has already moved on — that would overwrite the delivery stamps and
  // write a backward StatusHistory row. The UI hides the form once delivered,
  // but a hand-crafted POST to the bound action would skip that gate.
  if (sign.status === "handed_off" || sign.status === "installed") {
    failDetail(
      signId,
      "Delivery can't be re-recorded after the item has been handed off or installed.",
    );
  }

  const qtyRaw = formData.get("receivedQty");
  const qtyStr = typeof qtyRaw === "string" ? qtyRaw.trim() : "";
  // Distinguish "not provided" (null) from "provided but not a number" so the
  // user gets a precise message instead of a generic schema failure.
  if (qtyStr !== "" && !Number.isFinite(Number(qtyStr))) {
    failDetail(signId, "Received qty must be a number.");
  }
  const receivedQty = qtyStr === "" ? null : Number(qtyStr);
  const conditionRaw = formData.get("condition");
  const condition =
    typeof conditionRaw === "string" && conditionRaw.trim() !== ""
      ? conditionRaw.trim()
      : null;

  const parsed = deliverySchema.safeParse({ receivedQty, condition });
  if (!parsed.success) {
    failDetail(
      signId,
      parsed.error.issues[0]?.message ?? "Invalid delivery details.",
    );
  }

  const photoPath = await uploadOptionalPhoto(signId, "delivery", formData);

  const changedBy = session.user.email ?? session.user.id;
  const stamps = stampsForStatus("delivered", changedBy, new Date());

  const parts: string[] = [];
  if (parsed.data.receivedQty != null) {
    parts.push(`received ${parsed.data.receivedQty}`);
  }
  if (parsed.data.condition) parts.push(`condition: ${parsed.data.condition}`);
  const notes = parts.length ? `Delivery — ${parts.join("; ")}` : "Delivery recorded";

  // Captured from the locked (committed) status inside the tx so the audit row
  // records the true from-status. (#90)
  let fromStatus = sign.status;
  // Lock the row and re-check status INSIDE the tx so two concurrent submits
  // (double-tap / retried POST) can't both pass the guard and each write a
  // "delivered" history row (H3). loadExternalSign above is a cheap early-exit;
  // this is the authoritative, race-safe guard — and oldStatus is the locked
  // (committed) value rather than the possibly-stale pre-tx read.
  await persistWithPhoto(photoPath, async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM signs WHERE id = ${signId} FOR UPDATE`;
    const current = locked[0]?.status;
    if (current === undefined) failList("Sign not found.");
    refuseIfArchived(signId, current);
    if (current === "delivered") {
      failDetail(signId, "Delivery has already been recorded for this item.");
    }
    if (current === "handed_off" || current === "installed") {
      failDetail(
        signId,
        "Delivery can't be re-recorded after the item has been handed off or installed.",
      );
    }
    fromStatus = current;
    await tx.sign.update({
      where: { id: signId },
      data: {
        status: "delivered",
        ...stamps,
        receivedQty: parsed.data.receivedQty,
        deliveryCondition: parsed.data.condition,
        ...(photoPath ? { deliveryPhotoUrl: photoPath } : {}),
      },
    });
    await tx.statusHistory.create({
      data: { signId, oldStatus: current, newStatus: "delivered", changedBy, notes },
    });
  });

  // Physical-handoff accountability: mirror #78 for the full external-item
  // lifecycle so delivery/handoff/install show in the admin audit trail. (#90)
  await recordAudit({
    action: "sign.lifecycle",
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail:
      `sign #${signId} ${fromStatus} → delivered` +
      (parts.length ? ` (${parts.join("; ")})` : ""),
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// --- Hand off to a union crew / ops team --------------------------------------
const handoffSchema = z.object({
  recipient: z.string().min(1, "A recipient is required.").max(200),
  notes: z.string().max(2000).nullable(),
});

export async function recordHandoff(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  await assertMutateBudget(signId, session.user.id);

  const sign = await loadExternalSign(signId);
  // Same backward-overwrite guard as recordDelivery: once installed, the handoff
  // step is behind us and re-recording it would corrupt the lifecycle trail.
  if (sign.status === "installed") {
    failDetail(
      signId,
      "Handoff can't be re-recorded after the item is installed.",
    );
  }

  const recipientRaw = formData.get("handedOffTo");
  const recipient =
    typeof recipientRaw === "string" ? recipientRaw.trim() : "";
  const parsed = handoffSchema.safeParse({
    recipient,
    notes: optNotes(formData, 2000),
  });
  if (!parsed.success) {
    failDetail(
      signId,
      parsed.error.issues[0]?.message ?? "Invalid handoff details.",
    );
  }

  const photoPath = await uploadOptionalPhoto(signId, "handoff", formData);

  const changedBy = session.user.email ?? session.user.id;
  const stamps = stampsForStatus("handed_off", changedBy, new Date());

  const notes = parsed.data.notes
    ? `Handed off to ${parsed.data.recipient} — ${parsed.data.notes}`
    : `Handed off to ${parsed.data.recipient}`;

  let fromStatus = sign.status; // captured from the locked status in the tx (#90)
  // Lock + re-check inside the tx (H3): serialize concurrent submits so a
  // double-tap can't write two "handed_off" history rows. Authoritative guard;
  // the pre-tx check is an early-exit.
  await persistWithPhoto(photoPath, async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM signs WHERE id = ${signId} FOR UPDATE`;
    const current = locked[0]?.status;
    if (current === undefined) failList("Sign not found.");
    refuseIfArchived(signId, current);
    if (current === "handed_off") {
      failDetail(signId, "Handoff has already been recorded for this item.");
    }
    if (current === "installed") {
      failDetail(signId, "Handoff can't be re-recorded after the item is installed.");
    }
    fromStatus = current;
    await tx.sign.update({
      where: { id: signId },
      data: {
        status: "handed_off",
        ...stamps,
        handedOffTo: parsed.data.recipient,
        handoffNotes: parsed.data.notes,
        ...(photoPath ? { handoffPhotoUrl: photoPath } : {}),
      },
    });
    await tx.statusHistory.create({
      data: { signId, oldStatus: current, newStatus: "handed_off", changedBy, notes },
    });
  });

  // Physical-handoff accountability (#90).
  await recordAudit({
    action: "sign.lifecycle",
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail: `sign #${signId} ${fromStatus} → handed_off (to ${parsed.data.recipient})`,
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// --- Confirm the item was installed -------------------------------------------
export async function confirmInstalled(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  await assertMutateBudget(signId, session.user.id);

  const sign = await loadExternalSign(signId);
  // Same re-POST guard as the sibling lifecycle steps: a duplicate confirm
  // would overwrite the install stamps/notes/photo and write a noise history
  // row for a transition that never happened.
  if (sign.status === "installed") {
    failDetail(signId, "This item is already confirmed installed.");
  }

  const extra = optNotes(formData, 2000);

  const photoPath = await uploadOptionalPhoto(signId, "install", formData);

  const changedBy = session.user.email ?? session.user.id;
  const stamps = stampsForStatus("installed", changedBy, new Date());
  const notes = extra ? `Installed — ${extra}` : "Installation confirmed";

  let fromStatus = sign.status; // captured from the locked status in the tx (#90)
  // Lock + re-check inside the tx (H3): serialize concurrent submits so a
  // double-tap can't write two "installed" history rows. Authoritative guard;
  // the pre-tx check is an early-exit.
  await persistWithPhoto(photoPath, async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM signs WHERE id = ${signId} FOR UPDATE`;
    const current = locked[0]?.status;
    if (current === undefined) failList("Sign not found.");
    refuseIfArchived(signId, current);
    if (current === "installed") {
      failDetail(signId, "This item is already confirmed installed.");
    }
    fromStatus = current;
    await tx.sign.update({
      where: { id: signId },
      data: {
        status: "installed",
        ...stamps,
        installNotes: extra,
        ...(photoPath ? { installPhotoUrl: photoPath } : {}),
      },
    });
    await tx.statusHistory.create({
      data: { signId, oldStatus: current, newStatus: "installed", changedBy, notes },
    });
  });

  // Physical-handoff accountability (#90).
  await recordAudit({
    action: "sign.lifecycle",
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail: `sign #${signId} ${fromStatus} → installed`,
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}
