"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { logError } from "@/lib/log";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { requireRole, requireSession } from "@/lib/rbac";
import { CHANGE_TYPE } from "@/lib/change-history";
import { formatLabelForSign, formatTupleDiffers } from "@/lib/sign-format";
import { decideStatusChange } from "@/lib/sign-status-authz";
import { actorCrewIds } from "@/lib/sign-claims";
import { SYSTEM_TAG_SLUG_LIST } from "@/lib/tags";
import type { SignCategory, SignStatus } from "@/app/generated/prisma/client";

import { SIGN_STATUSES, stampsForStatus } from "./_lib";
import {
  checkRefs,
  readSignForm,
  signSchema,
  toSignData,
} from "./_form-shared";
import type { SignFormState } from "./_form-state";

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

  // Generous per-actor backstop (60/min) — open to every active user, so a
  // role gate alone is not a throttle.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    failDetail(signId, "Too many changes at once — wait a minute and try again.");
  }

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
    !(SIGN_STATUSES as readonly SignStatus[]).includes(next as SignStatus)
  ) {
    failDetail(signId, "Invalid status.");
  }
  const newStatus = next as SignStatus;

  // Cheap pre-flight so the common rejections (missing sign, no-op, unauthorized)
  // don't pay for a transaction. NOT the authoritative check — that happens
  // against the locked row below.
  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true, status: true },
  });
  if (!sign) failList("Sign not found.");

  if (sign.status === newStatus) {
    failDetail(signId, "Sign is already in that status.");
  }

  // Resolve the actor's crews BEFORE opening the transaction: the claim check
  // needs a second query, and running it while holding a row lock would take a
  // second pooled connection for the duration of the lock. Membership is a
  // property of the actor, not the sign, so reading it early is race-free —
  // the sign's claim itself is re-read under the lock.
  const crewIds =
    newStatus === "deployed" ? await actorCrewIds(session.user.id) : [];

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();

  // Delivery/deployment stamps follow the target status (shared with the bulk
  // path). See stampsForStatus in _lib.ts for the rules.
  const stamps = stampsForStatus(newStatus, changedBy, now);

  // Lock the row and re-decide inside the transaction (#171). Without this, two
  // concurrent submits for the same sign (double-tap, two floor staff, a client
  // retry racing the original) both authorize against the same stale snapshot and
  // both commit — the loser writing a StatusHistory row whose `oldStatus` is not
  // what it actually overwrote, corrupting the per-sign timeline that #83/#90
  // exist to protect. Same guard the lifecycle actions and generateSelection use.
  //
  // The transaction RETURNS its verdict rather than redirecting from inside:
  // failDetail/failList throw, which would roll the tx back before the denial
  // audit row (#83) could be written. Handled below, after the tx closes.
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      {
        status: SignStatus;
        category: SignCategory;
        claimedByCrewId: number | null;
      }[]
    >`SELECT status, category, claimed_by_crew_id AS "claimedByCrewId" FROM signs WHERE id = ${signId} FOR UPDATE`;
    const row = locked[0];
    if (!row) return { kind: "missing" as const };
    if (row.status === newStatus) return { kind: "noop" as const };

    // H2: volunteers are forward-only and need their crew's claim to mark a sign
    // deployed; backward moves are lead/admin only. Leads/admins are unrestricted
    // except for the archived + external-category rules. Decided against the
    // LOCKED status and claim, not the pre-flight snapshot.
    const decision = decideStatusChange({
      role: session.user.role,
      currentStatus: row.status,
      targetStatus: newStatus,
      actorHoldsClaim:
        row.claimedByCrewId !== null && crewIds.includes(row.claimedByCrewId),
      category: row.category,
    });
    if (!decision.ok) {
      return {
        kind: "denied" as const,
        from: row.status,
        reason: decision.reason,
      };
    }

    await tx.sign.update({
      where: { id: signId },
      data: { status: newStatus, ...stamps },
    });
    await tx.statusHistory.create({
      data: {
        signId,
        // The locked (committed) value, so the timeline records what this write
        // actually replaced.
        oldStatus: row.status,
        newStatus,
        changedBy,
        notes,
      },
    });
    return { kind: "applied" as const };
  });

  if (outcome.kind === "missing") failList("Sign not found.");
  if (outcome.kind === "noop") {
    failDetail(signId, "Sign is already in that status.");
  }
  // Leave a trace of a denied status change so a privilege probe (e.g. a
  // volunteer repeatedly attempting a lead-only backward move, or moving a sign
  // they don't hold the claim on) is visible in the audit log rather than
  // silently bounced to the detail page. (#83)
  if (outcome.kind === "denied") {
    await recordAudit({
      action: "sign.status_denied",
      actorId: session.user.id,
      actorEmail: session.user.email,
      detail: `Denied ${outcome.from} → ${newStatus} on sign #${signId}: ${outcome.reason}`,
    });
    failDetail(signId, outcome.reason);
  }

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
  const session = await requireSession();

  // Same generous backstop as updateSignStatus — open to every active user,
  // so a role gate alone is not a throttle.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    failDetail(signId, "Too many changes at once — wait a minute and try again.");
  }

  const collected = formData.get("collected") === "1";
  const exists = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true },
  });
  if (!exists) failList("Sign not found.");

  await prisma.sign
    .update({ where: { id: signId }, data: { equipmentCheckedOut: collected } })
    .catch(() => failDetail(signId, "Could not update hardware status."));

  // Equipment accountability: the bulk path (bulk.hardware) audits, so the
  // single-sign path must too — otherwise a checkout change made here is
  // invisible in a gear-loss investigation. (#78)
  await recordAudit({
    action: "sign.hardware",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Marked hardware ${collected ? "collected" : "not collected"} on sign #${signId}`,
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// ---------------------------------------------------------------------------
// Hardware return — the strike-time mirror of setHardwareCollected. Tracks
// whether gear that was checked out has been returned; the UI only surfaces
// this once a sign needs hardware AND that hardware was checked out (can't
// return gear never collected). Same operational-flag treatment as checkout:
// open to any active user, no StatusHistory row, audited like the bulk path.
// ---------------------------------------------------------------------------
export async function setHardwareReturned(
  signId: number,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();

  // Same generous backstop as setHardwareCollected — open to every active
  // user, so a role gate alone is not a throttle.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    failDetail(signId, "Too many changes at once — wait a minute and try again.");
  }

  const returned = formData.get("returned") === "1";
  const exists = await prisma.sign.findUnique({
    where: { id: signId },
    select: { id: true },
  });
  if (!exists) failList("Sign not found.");

  await prisma.sign
    .update({ where: { id: signId }, data: { equipmentReturned: returned } })
    .catch(() => failDetail(signId, "Could not update hardware status."));

  // Equipment accountability: the bulk path (bulk.hardware_return) audits, so
  // the single-sign path must too, mirroring the #78 rationale for checkout.
  await recordAudit({
    action: "sign.hardware_return",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Marked hardware ${returned ? "returned" : "not returned"} on sign #${signId}`,
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
}

// ---------------------------------------------------------------------------
// Create / edit / delete — lead+ only.
// ---------------------------------------------------------------------------
// readSignForm / signSchema / toSignData / checkRefs moved verbatim to
// ./_form-shared.ts so the specialty bulk-intake action can reuse them
// ("use server" files may only export async functions).

// createSign/updateSign are driven by SignForm via useActionState, so they take
// the prior form state and RETURN a typed error ({ error }) that the form renders
// inline — instead of the ?error= redirect the other actions use — while success
// still redirects to the detail page. (The redirect-based failList/failDetail
// helpers stay for the status/lifecycle actions, which have no client form.)
export async function createSign(
  _prev: SignFormState,
  formData: FormData,
): Promise<SignFormState> {
  const session = await requireRole("lead");

  // Per-actor mutation backstop — parity with the sibling mutating actions
  // (updateSignStatus / setHardware* / bulk); createSign previously had none, so
  // a scripted caller could hammer the create path unthrottled. Fails open in dev
  // (no Upstash env), same as everywhere else.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    return { error: "Too many changes at once — wait a minute and try again." };
  }

  const raw = readSignForm(formData);
  const parsed = signSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid sign details.",
    };
  }

  const refError = await checkRefs(parsed.data.zoneId, raw.tagIds);
  if (refError) return { error: refError };

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
    logError("signs.create", err);
    return {
      error: "Could not create the sign. Check the details and try again.",
    };
  }

  await recordAudit({
    action: "sign.create",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Created sign #${newId} "${parsed.data.itemId}"`,
  });

  revalidatePath("/signs");
  redirect(`/signs/${newId}`);
}

export async function updateSign(
  signId: number,
  _prev: SignFormState,
  formData: FormData,
): Promise<SignFormState> {
  const session = await requireRole("lead");

  // Same per-actor mutation backstop as createSign (see note there).
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    return { error: "Too many changes at once — wait a minute and try again." };
  }

  const raw = readSignForm(formData);
  const parsed = signSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid sign details.",
    };
  }

  // Select the full format tuple (not just id) so a reformat can be diffed and
  // logged to the per-sign timeline. Diff the WHOLE tuple, not size alone — the
  // advanced/custom path can change signType/category/double-sided at a constant
  // size string, and that's a real format change.
  const exists = await prisma.sign.findUnique({
    where: { id: signId },
    select: {
      id: true,
      size: true,
      signType: true,
      category: true,
      doubleSided: true,
      // Lets checkRefs tell "kept its existing zone" (allowed even if that zone
      // has since been deactivated) from "moved onto an inactive zone" (refused).
      zoneId: true,
    },
  });
  if (!exists) return { error: "Sign not found." };

  const refError = await checkRefs(
    parsed.data.zoneId,
    raw.tagIds,
    exists.zoneId,
  );
  if (refError) return { error: refError };

  const formatChanged = formatTupleDiffers(exists, parsed.data);
  const oldFormatLabel = formatLabelForSign(exists);
  const newFormatLabel = formatLabelForSign(parsed.data);

  // Replace tag assignments wholesale (delete + recreate) to match the submitted
  // checkbox set — but PRESERVE system tags (e.g. `master-sheet`): they're hidden
  // from the form, so they'd never be resubmitted and a blind delete would silently
  // strip them, dropping the sign out of reconcile scope. The recreate uses
  // skipDuplicates so a hand-crafted submission of a system tag id can't collide with
  // the preserved assignment. Status is NOT touched here — that goes through
  // updateSignStatus, which records history.
  try {
    await prisma.$transaction([
      prisma.sign.update({
        where: { id: signId },
        data: toSignData(parsed.data),
      }),
      // A reformat is recorded on the same per-sign timeline as status changes,
      // carrying the from/to format labels (change_type distinguishes it so the
      // renderers never treat a label as a status). Skipped when the format is
      // unchanged (a plain field edit writes no format row).
      ...(formatChanged
        ? [
            prisma.statusHistory.create({
              data: {
                signId,
                changeType: CHANGE_TYPE.format,
                oldStatus: oldFormatLabel,
                newStatus: newFormatLabel,
                changedBy: session.user.email ?? session.user.id,
              },
            }),
          ]
        : []),
      prisma.signTagAssignment.deleteMany({
        where: { signId, tag: { slug: { notIn: SYSTEM_TAG_SLUG_LIST } } },
      }),
      ...(raw.tagIds.length > 0
        ? [
            prisma.signTagAssignment.createMany({
              data: raw.tagIds.map((tagId) => ({ signId, tagId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
  } catch (err) {
    logError("signs.update", err);
    return {
      error: "Could not save changes. Check the details and try again.",
    };
  }

  await recordAudit({
    action: "sign.update",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Updated sign #${signId} "${parsed.data.itemId}"${
      formatChanged ? ` (format ${oldFormatLabel} → ${newFormatLabel})` : ""
    }`,
  });

  revalidatePath("/signs");
  revalidatePath(`/signs/${signId}`);
  redirect(`/signs/${signId}`);
}

// Record a delete that did NOT happen. A failed delete used to leave nothing
// behind at all, so "why didn't sign #X delete?" had no server-side answer —
// same reasoning as the sign.status_denied trace above (#83/#234).
async function auditDeleteFailure(
  session: { user: { id: string; email?: string | null } },
  signId: number,
  reason: string,
): Promise<void> {
  await recordAudit({
    action: "sign.delete_failed",
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail: `Delete of sign #${signId} failed: ${reason}`,
  });
}

export async function deleteSign(signId: number): Promise<void> {
  const session = await requireRole("lead");

  // Per-actor backstop, matching every sibling mutation in this file. deleteSign
  // was the one without it, which now also means an unbounded sign.delete_failed
  // row per attempt — a retry loop could flood the audit table it just started
  // writing to. Fails open in dev (no Upstash env), same as everywhere else.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    failList("Too many changes at once — wait a minute and try again.");
  }

  // Read first, purely for the audit detail (the row is gone by the time we log).
  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { itemId: true },
  });

  // deleteMany (not delete) + a count check so a duplicate/concurrent delete is a
  // distinguishable no-op instead of a P2025 caught by the same generic handler
  // as a real DB fault — the pattern deleteGenerationBatch/updateBatchFigmaUrl
  // already use in generate-actions.ts. Cascade (schema onDelete) clears
  // status_history + tag assignments.
  let deleted: number;
  try {
    const res = await prisma.sign.deleteMany({ where: { id: signId } });
    deleted = res.count;
  } catch (err) {
    logError("signs.delete", err, { signId });
    await auditDeleteFailure(session, signId, "database error");
    failList("Could not delete the sign.");
  }

  if (deleted === 0) {
    await auditDeleteFailure(session, signId, "no such sign (already deleted?)");
    failList("That sign no longer exists — it may have already been deleted.");
  }

  await recordAudit({
    action: "sign.delete",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Deleted sign #${signId}${sign ? ` "${sign.itemId}"` : ""}`,
  });

  revalidatePath("/signs");
  redirect("/signs");
}
