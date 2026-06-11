"use server";

import { prisma } from "@/lib/db";
import { requireRole, requireSession } from "@/lib/rbac";
import type { Prisma, SignStatus } from "@/app/generated/prisma/client";

import {
  DEPLOYMENT_SLOTS,
  SIGN_STATUSES,
  buildSignWhere,
  stampsForStatus,
} from "./_lib";
import {
  CHUNK,
  type BulkTarget,
  auditBulk,
  chunk,
  done,
  fail,
  readTarget,
  resolveRows,
  runWrite,
  safeReturnTo,
  targetDesc,
} from "./_bulk-shared";

// ---------------------------------------------------------------------------
// Bulk operations over a selection made on the /signs list. The selection
// parsing + helpers live in ./_bulk-shared (shared with generate-actions.ts);
// this file holds the "use server" actions only.
//
// Permissions mirror the single-sign paths: status is open to any active user
// (floor staff advance signs), while zone/slot/tag/delete edit the same fields
// updateSign/deleteSign gate behind `lead`, so bulk does too.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status — any active user.
// ---------------------------------------------------------------------------
export async function bulkSetStatus(formData: FormData): Promise<void> {
  const session = await requireSession();
  const returnTo = safeReturnTo(formData);

  // Namespaced "setStatus" (not "status") so it never collides with the "status"
  // filter key when the selection is "all matching the current filter".
  const next = formData.get("setStatus");
  if (typeof next !== "string" || !SIGN_STATUSES.includes(next as SignStatus)) {
    fail(returnTo, "Invalid status.");
  }
  const newStatus = next as SignStatus;
  const target = readTarget(formData, returnTo);

  // Skip rows already at the target so history doesn't record no-ops.
  const rows = await resolveRows(target, { status: { not: newStatus } });
  if (rows.length === 0) done(returnTo);

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();
  const stamps = stampsForStatus(newStatus, changedBy, now);

  // One transaction per chunk: updateMany the status + stamps, then one history
  // row per affected sign. The stamp patch is identical for every row (it's a
  // pure function of the target), so updateMany is correct across mixed inputs.
  await runWrite(returnTo, "bulkSetStatus", async () => {
    for (const part of chunk(rows, CHUNK)) {
      const ids = part.map((r) => r.id);
      await prisma.$transaction([
        prisma.sign.updateMany({
          where: { id: { in: ids } },
          data: { status: newStatus, ...stamps },
        }),
        prisma.statusHistory.createMany({
          data: part.map((r) => ({
            signId: r.id,
            oldStatus: r.status,
            newStatus,
            changedBy,
            notes: null,
          })),
        }),
      ]);
    }
  });

  await auditBulk(session, "bulk.status", `Set ${rows.length} sign${rows.length === 1 ? "" : "s"} to ${newStatus}`);
  done(returnTo);
}

// Hardware collected — operational, any active user (like status). Sets the
// equipmentCheckedOut flag across the selection; harmless on signs that need no
// hardware (it just never surfaces).
export async function bulkSetHardwareCollected(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);
  const collected = formData.get("collected") === "1";

  await runWrite(returnTo, "bulkSetHardwareCollected", () =>
    updateManyTarget(target, { equipmentCheckedOut: collected }),
  );
  await auditBulk(
    session,
    "bulk.hardware",
    `Marked hardware ${collected ? "collected" : "not collected"} on ${targetDesc(target)}`,
  );
  done(returnTo);
}

// ---------------------------------------------------------------------------
// Zone / slot / tag / delete — lead+.
// ---------------------------------------------------------------------------
export async function bulkSetZone(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);

  const zoneId = Number(formData.get("zoneId"));
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    fail(returnTo, "Choose a zone.");
  }
  const zone = await prisma.zone.findUnique({
    where: { id: zoneId },
    select: { isActive: true },
  });
  if (!zone || !zone.isActive) fail(returnTo, "Selected zone is not available.");

  await runWrite(returnTo, "bulkSetZone", () =>
    updateManyTarget(target, { zoneId }),
  );
  await auditBulk(session, "bulk.zone", `Set zone #${zoneId} on ${targetDesc(target)}`);
  done(returnTo);
}

export async function bulkSetSlot(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);

  // Namespaced "setSlot" (not "slot") to avoid the "slot" filter-key collision.
  const raw = formData.get("setSlot");
  const slot = typeof raw === "string" ? raw : "";
  // Empty clears the slot; otherwise it must be a known deployment slot.
  if (slot !== "" && !DEPLOYMENT_SLOTS.some((s) => s.value === slot)) {
    fail(returnTo, "Invalid deployment slot.");
  }

  await runWrite(returnTo, "bulkSetSlot", () =>
    updateManyTarget(target, { deploymentSlot: slot === "" ? null : slot }),
  );
  await auditBulk(
    session,
    "bulk.slot",
    `Set slot "${slot === "" ? "(cleared)" : slot}" on ${targetDesc(target)}`,
  );
  done(returnTo);
}

export async function bulkAddTag(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);
  const tagId = await readTagId(formData, returnTo);

  const rows = await resolveRows(target);
  await runWrite(returnTo, "bulkAddTag", async () => {
    for (const part of chunk(rows, CHUNK)) {
      await prisma.signTagAssignment.createMany({
        data: part.map((r) => ({ signId: r.id, tagId })),
        skipDuplicates: true,
      });
    }
  });
  await auditBulk(session, "bulk.tag_add", `Added tag #${tagId} to ${targetDesc(target)}`);
  done(returnTo);
}

export async function bulkRemoveTag(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);
  const tagId = await readTagId(formData, returnTo);

  await runWrite(returnTo, "bulkRemoveTag", async () => {
    if (target.kind === "filter") {
      await prisma.signTagAssignment.deleteMany({
        where: { tagId, sign: buildSignWhere(target.filters) },
      });
    } else {
      for (const part of chunk(target.ids, CHUNK)) {
        await prisma.signTagAssignment.deleteMany({
          where: { tagId, signId: { in: part } },
        });
      }
    }
  });
  await auditBulk(session, "bulk.tag_remove", `Removed tag #${tagId} from ${targetDesc(target)}`);
  done(returnTo);
}

export async function bulkDelete(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);

  // Cascade (schema onDelete) clears status_history + tag assignments.
  // Note: an all-matching delete with empty filters intentionally removes every
  // sign — a lead-only action guarded by a client-side confirm in the BulkBar.
  await runWrite(returnTo, "bulkDelete", async () => {
    if (target.kind === "filter") {
      await prisma.sign.deleteMany({ where: buildSignWhere(target.filters) });
    } else {
      for (const part of chunk(target.ids, CHUNK)) {
        await prisma.sign.deleteMany({ where: { id: { in: part } } });
      }
    }
  });
  await auditBulk(session, "bulk.delete", `Deleted ${targetDesc(target)}`);
  done(returnTo);
}

// Shared: a set-style column write across the whole selection. One statement for
// the filter case; chunked id-IN statements otherwise.
async function updateManyTarget(
  target: BulkTarget,
  // Unchecked variant so a foreign-key scalar like zoneId can be set directly.
  data: Prisma.SignUncheckedUpdateManyInput,
): Promise<void> {
  if (target.kind === "filter") {
    await prisma.sign.updateMany({
      where: buildSignWhere(target.filters),
      data,
    });
    return;
  }
  for (const part of chunk(target.ids, CHUNK)) {
    await prisma.sign.updateMany({ where: { id: { in: part } }, data });
  }
}

async function readTagId(fd: FormData, returnTo: string): Promise<number> {
  const tagId = Number(fd.get("tagId"));
  if (!Number.isInteger(tagId) || tagId <= 0) fail(returnTo, "Choose a tag.");
  const tag = await prisma.signTag.findUnique({
    where: { id: tagId },
    select: { id: true },
  });
  if (!tag) fail(returnTo, "Selected tag no longer exists.");
  return tagId;
}
