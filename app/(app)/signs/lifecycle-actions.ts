"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac";
import { validateImageUpload } from "@/lib/image-upload";
import { uploadSignPhoto, type SignPhotoKind } from "@/lib/sign-photos";

import { isExternalCategory, stampsForStatus } from "./_lib";
import type { SignCategory } from "@/app/generated/prisma/enums";

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

function photoErrorMessage(error: string): string {
  switch (error) {
    case "too_large":
      return "Photo is too large (max 10 MB).";
    case "unsupported_type":
      return "Photo must be a PNG, JPEG, or WebP image.";
    default:
      return "Photo could not be read.";
  }
}

// Read an optional "photo" file field: validate its magic bytes and upload to
// private Blob, returning the stored pathname (or null if none supplied). Uses the
// validated content type, never the browser-declared one. Throws a user-facing
// redirect on an invalid image. Uploaded before the DB write — a Blob orphaned by
// a failed transaction is harmless (private + unreferenced).
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

function optNotes(formData: FormData, max: number): string | null {
  const raw = formData.get("notes");
  const v = typeof raw === "string" ? raw.trim() : "";
  return v === "" ? null : v.slice(0, max);
}

// Fetch a sign for a lifecycle action, asserting it's an externally-installed
// class (union_installed / ops_map). The dedicated UI only renders for these;
// guarding here keeps the receiving/handoff/install fields off a sign that doesn't
// belong on this fork (defense for a hand-crafted POST to a bound action).
async function loadExternalSign(
  signId: number,
): Promise<{ id: number; status: string; category: SignCategory }> {
  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true, status: true, category: true },
  });
  if (!sign) failList("Sign not found.");
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

  await prisma.$transaction([
    prisma.sign.update({
      where: { id: signId },
      data: {
        status: "delivered",
        ...stamps,
        receivedQty: parsed.data.receivedQty,
        deliveryCondition: parsed.data.condition,
        ...(photoPath ? { deliveryPhotoUrl: photoPath } : {}),
      },
    }),
    prisma.statusHistory.create({
      data: { signId, oldStatus: sign.status, newStatus: "delivered", changedBy, notes },
    }),
  ]);

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

  await prisma.$transaction([
    prisma.sign.update({
      where: { id: signId },
      data: {
        status: "handed_off",
        ...stamps,
        handedOffTo: parsed.data.recipient,
        handoffNotes: parsed.data.notes,
        ...(photoPath ? { handoffPhotoUrl: photoPath } : {}),
      },
    }),
    prisma.statusHistory.create({
      data: { signId, oldStatus: sign.status, newStatus: "handed_off", changedBy, notes },
    }),
  ]);

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// --- Confirm the item was installed -------------------------------------------
export async function confirmInstalled(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();

  const sign = await loadExternalSign(signId);

  const extra = optNotes(formData, 2000);

  const photoPath = await uploadOptionalPhoto(signId, "install", formData);

  const changedBy = session.user.email ?? session.user.id;
  const stamps = stampsForStatus("installed", changedBy, new Date());
  const notes = extra ? `Installed — ${extra}` : "Installation confirmed";

  await prisma.$transaction([
    prisma.sign.update({
      where: { id: signId },
      data: {
        status: "installed",
        ...stamps,
        installNotes: extra,
        ...(photoPath ? { installPhotoUrl: photoPath } : {}),
      },
    }),
    prisma.statusHistory.create({
      data: { signId, oldStatus: sign.status, newStatus: "installed", changedBy, notes },
    }),
  ]);

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}
