"use server";

import { prisma } from "@/lib/db";
import { CHANGE_TYPE } from "@/lib/change-history";
import {
  formatForKey,
  formatLabelForSign,
  formatTupleDiffers,
} from "@/lib/sign-format";
import { hasRole, requireRole, requireSession } from "@/lib/rbac";
import {
  decideStatusChange,
  forwardSourceStatuses,
  isLeadOnlyStatusTarget,
} from "@/lib/sign-status-authz";
import { actorCrewIds } from "@/lib/sign-claims";
import { isSystemTag } from "@/lib/tags";
import type { Prisma, SignStatus } from "@/app/generated/prisma/client";

import {
  ARCHIVED_STATUS,
  DEPLOYMENT_SLOTS,
  EXTERNAL_CATEGORIES,
  SIGN_STATUSES,
  buildSignWhere,
  stampsForStatus,
} from "./_lib";
import {
  CHUNK,
  type BulkTarget,
  assertMutateBudget,
  auditBulk,
  chunk,
  done,
  doneWithNotice,
  fail,
  lockSigns,
  nonArchivedWhere,
  readTarget,
  resolveRows,
  runWrite,
  safeReturnTo,
  targetDesc,
  targetWhere,
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
  await assertMutateBudget(session, returnTo);

  // Namespaced "setStatus" (not "status") so it never collides with the "status"
  // filter key when the selection is "all matching the current filter".
  const next = formData.get("setStatus");
  if (
    typeof next !== "string" ||
    !(SIGN_STATUSES as readonly SignStatus[]).includes(next as SignStatus)
  ) {
    fail(returnTo, "Invalid status.");
  }
  const newStatus = next as SignStatus;
  const target = readTarget(formData, returnTo);

  // handed_off / installed are the external-item terminals: lead/admin-only AND
  // only meaningful on union_installed / ops_map rows (#232). Narrowing the
  // resolve here is what makes the operator's "skipped N" message accurate; the
  // authoritative refusal is decideStatusChange, applied per locked row below.
  const externalOnly = isLeadOnlyStatusTarget(newStatus);
  const isLead = hasRole(session.user.role, "lead");
  // Rank-only prefilter for the volunteer branch — NOT an authorization answer
  // on its own (#199); every surviving row is still put through the policy.
  const forwardSources = forwardSourceStatuses(newStatus);

  // H2/#20: leads/admins set status freely (skip only no-ops). Volunteers are
  // restricted to FORWARD moves on signs THEIR crew has claimed — so an
  // allMatching selection is intersected down to their claimed, eligible signs:
  // no mass-corruption of the whole inventory, no backward moves, and `deployed`
  // is reachable only for signs they hold (every eligible row is crew-claimed).
  let rows: { id: number; status: SignStatus }[];
  let crewIds: number[] = [];
  if (isLead) {
    // Exclude archived: a removed sign is not a status-change source — it leaves
    // `archived` only through Restore (which lands it at its prior status). The
    // volunteer branch is already archived-free via forwardSourceStatuses.
    rows = await resolveRows(target, {
      status: { notIn: [newStatus, ARCHIVED_STATUS] },
      ...(externalOnly ? { category: { in: [...EXTERNAL_CATEGORIES] } } : {}),
    });
  } else {
    if (externalOnly) {
      fail(returnTo, "Only a lead or admin can set this status.");
    }
    crewIds = await actorCrewIds(session.user.id);
    if (crewIds.length === 0) {
      fail(returnTo, "You can only change the status of signs your crew has claimed.");
    }
    rows = await resolveRows(target, {
      status: { in: forwardSources },
      claimedByCrewId: { in: crewIds },
    });
  }

  // Tell the operator when a lead-only target silently dropped rows for being the
  // wrong item class, instead of just applying to fewer signs than they selected.
  // Mirrors the `rows` filter exactly (same status exclusions) so the count names
  // ONLY rows skipped for their category — a row that is also archived, or
  // already at the target, was skipped for a different reason and must not be
  // reported under this one.
  const wrongClass = externalOnly
    ? await prisma.sign.count({
        where: {
          AND: [
            targetWhere(target),
            { status: { notIn: [newStatus, ARCHIVED_STATUS] } },
            { category: { notIn: [...EXTERNAL_CATEGORIES] } },
          ],
        },
      })
    : 0;

  if (rows.length === 0) {
    if (wrongClass > 0) {
      fail(
        returnTo,
        "Handed off / installed apply only to externally-installed items (banners, graphics, ops maps).",
      );
    }
    done(returnTo);
  }

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();
  const stamps = stampsForStatus(newStatus, changedBy, now);

  // One transaction per chunk: lock the chunk's rows, re-read their CURRENT
  // status/claim/category, re-decide, then updateMany the status + stamps and
  // write one history row per row that actually moved.
  //
  // The lock + re-read is the #222 fix: previously the eligibility snapshot was
  // taken by a plain findMany before the transaction, so a claim reassignment or
  // a second overlapping bulk op landing in between still got written — with a
  // StatusHistory `oldStatus` that never existed at write time. The per-row
  // decideStatusChange is the #199 fix: the DB prefilters above are a cheap
  // narrowing, and the shared policy (deployed-needs-claim, lead-only targets,
  // archived, external-category) is what actually authorizes each write — the
  // same policy the single-sign path uses. The stamp patch is identical for every
  // row (a pure function of the target), so updateMany is correct across mixed
  // inputs.
  let applied = 0;
  await runWrite(returnTo, "bulkSetStatus", async () => {
    for (const part of chunk(rows, CHUNK)) {
      const ids = part.map((r) => r.id);
      await prisma.$transaction(
        async (tx) => {
          await lockSigns(tx, ids);
          const fresh = await tx.sign.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              status: true,
              category: true,
              claimedByCrewId: true,
            },
          });
          const eligible = fresh.filter((r) => {
            if (r.status === newStatus) return false;
            const holdsClaim =
              r.claimedByCrewId !== null && crewIds.includes(r.claimedByCrewId);
            // Re-apply the volunteer narrowing against the locked row: it is
            // STRICTER than the policy (every targeted row must be crew-claimed,
            // not just the `deployed` ones), and #20 depends on that blast-radius
            // limit holding at write time, not just at read time.
            if (!isLead && (!forwardSources.includes(r.status) || !holdsClaim)) {
              return false;
            }
            return decideStatusChange({
              role: session.user.role,
              currentStatus: r.status,
              targetStatus: newStatus,
              actorHoldsClaim: holdsClaim,
              category: r.category,
            }).ok;
          });
          if (eligible.length === 0) return;
          applied += eligible.length;
          await tx.sign.updateMany({
            where: { id: { in: eligible.map((r) => r.id) } },
            data: { status: newStatus, ...stamps },
          });
          await tx.statusHistory.createMany({
            data: eligible.map((r) => ({
              signId: r.id,
              // From the locked read, so the timeline records what was actually
              // overwritten rather than a pre-transaction snapshot.
              oldStatus: r.status,
              newStatus,
              changedBy,
              notes: null,
            })),
          });
        },
        { timeout: 30_000 },
      );
    }
  });

  // Nothing committed and nothing was deliberately skipped — the whole selection
  // lost its eligibility to a concurrent write between the resolve and the lock.
  // Don't log a "Set 0 signs" row for it.
  if (applied > 0 || wrongClass > 0) {
    await auditBulk(
      session,
      "bulk.status",
      `Set ${applied} sign${applied === 1 ? "" : "s"} to ${newStatus}` +
        (wrongClass > 0 ? ` (${wrongClass} skipped — not an external item)` : ""),
    );
  }
  if (wrongClass > 0) {
    doneWithNotice(
      returnTo,
      `Set ${applied}; skipped ${wrongClass} sign${wrongClass === 1 ? "" : "s"} that ${wrongClass === 1 ? "is" : "are"} not an externally-installed item.`,
    );
  }
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
  await assertMutateBudget(session, returnTo);
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

// Hardware returned — the strike-time mirror of bulkSetHardwareCollected.
// Operational, any active user (like status/checkout). Sets the
// equipmentReturned flag across the selection; harmless on signs that need no
// hardware or were never checked out (it just never surfaces there).
export async function bulkSetHardwareReturned(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);
  const returned = formData.get("returned") === "1";

  await runWrite(returnTo, "bulkSetHardwareReturned", () =>
    updateManyTarget(target, { equipmentReturned: returned }),
  );
  await auditBulk(
    session,
    "bulk.hardware_return",
    `Marked hardware ${returned ? "returned" : "not returned"} on ${targetDesc(target)}`,
  );
  done(returnTo);
}

// ---------------------------------------------------------------------------
// Zone / slot / tag / delete — lead+.
// ---------------------------------------------------------------------------
export async function bulkSetZone(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
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
  await assertMutateBudget(session, returnTo);
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

// Set format — lead+. The "select 200, one click" resize: applies the canonical
// format's physical identity (size + signType + category + double-sided) across the
// selection, so a re-typed batch can't drift the way editing three fields by hand
// does. Double-sided IS the format here (Single vs Double are distinct keys), so a
// bulk reformat sets it deterministically. needsEasel is deliberately NOT touched —
// it's an independent operational marking (a format only *defaults* it on the
// single-sign picker), so a bulk reformat never silently strips a bare-easel override
// across a whole filter selection.
export async function bulkSetFormat(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);

  // Namespaced "setFormat" so it never collides with any list filter key.
  const raw = formData.get("setFormat");
  const fmt = typeof raw === "string" ? formatForKey(raw) : undefined;
  if (!fmt) fail(returnTo, "Choose a format.");

  // Resolve the affected rows with their FULL format tuple. resolveRows only
  // returns id/status, so read directly (widening the shared helper would ripple
  // into 5 other callers). "Changed" is a diff on the whole identity tuple, not
  // size alone: a mis-typed row can already match the target size yet differ in
  // signType/category/double-sided — that IS a real reformat and must be logged.
  // Archived rows are excluded server-side (#172).
  const rows = await prisma.sign.findMany({
    where: nonArchivedWhere(target),
    select: {
      id: true,
      size: true,
      signType: true,
      category: true,
      doubleSided: true,
    },
  });
  const candidates = rows.filter((r) => formatTupleDiffers(r, fmt));

  const changedBy = session.user.email ?? session.user.id;

  // One transaction per chunk: lock the chunk, re-read the format tuple under the
  // lock, re-diff, then apply the format to the still-differing rows AND write
  // their history rows together — so a mid-write failure can't leave signs
  // reformatted without a matching timeline entry, and a concurrent reformat
  // can't be overwritten with a stale "from" label (#222). No-op rows already in
  // the target format are skipped entirely.
  let changedCount = 0;
  await runWrite(returnTo, "bulkSetFormat", async () => {
    for (const part of chunk(candidates, CHUNK)) {
      const ids = part.map((r) => r.id);
      await prisma.$transaction(
        async (tx) => {
          await lockSigns(tx, ids);
          const fresh = await tx.sign.findMany({
            where: { id: { in: ids }, status: { not: ARCHIVED_STATUS } },
            select: {
              id: true,
              size: true,
              signType: true,
              category: true,
              doubleSided: true,
            },
          });
          const changed = fresh.filter((r) => formatTupleDiffers(r, fmt));
          if (changed.length === 0) return;
          changedCount += changed.length;
          await tx.sign.updateMany({
            where: { id: { in: changed.map((r) => r.id) } },
            data: {
              size: fmt.size,
              signType: fmt.signType,
              category: fmt.category,
              doubleSided: fmt.doubleSided,
            },
          });
          await tx.statusHistory.createMany({
            data: changed.map((r) => ({
              signId: r.id,
              changeType: CHANGE_TYPE.format,
              // Label built from the locked read, so it names the format this
              // write actually replaced.
              oldStatus: formatLabelForSign(r),
              newStatus: fmt.label,
              changedBy,
              notes: null,
            })),
          });
        },
        { timeout: 30_000 },
      );
    }
  });
  await auditBulk(
    session,
    "bulk.format",
    `Set format "${fmt.label}" (${fmt.size} / ${fmt.signType} / ${fmt.category}${fmt.doubleSided ? " / 2-sided" : ""}) — ${changedCount} of ${rows.length} changed on ${targetDesc(target)}`,
  );
  done(returnTo);
}

export async function bulkAddTag(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);
  const tagId = await readTagId(formData, returnTo);

  // Archived rows are not taggable — the Removed view hides this action, and the
  // server has to hold that line too (#172).
  const rows = await resolveRows(target, { status: { not: ARCHIVED_STATUS } });
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
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);
  const tagId = await readTagId(formData, returnTo);

  // Both branches exclude archived rows: stripping a tag off a removed sign would
  // change what it comes back as on Restore, and the Removed view never offers
  // this action (#172).
  await runWrite(returnTo, "bulkRemoveTag", async () => {
    if (target.kind === "filter") {
      await prisma.signTagAssignment.deleteMany({
        where: {
          tagId,
          sign: {
            AND: [buildSignWhere(target.filters), { status: { not: ARCHIVED_STATUS } }],
          },
        },
      });
    } else {
      for (const part of chunk(target.ids, CHUNK)) {
        await prisma.signTagAssignment.deleteMany({
          where: {
            tagId,
            signId: { in: part },
            sign: { status: { not: ARCHIVED_STATUS } },
          },
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
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);

  // Server-side count before the delete: the client-side confirm phrase is
  // UI-only and bypassable via a direct POST.  Echo the real count into the
  // audit trail so forensics have an exact record of what was wiped.
  const preCount =
    target.kind === "filter"
      ? await prisma.sign.count({ where: buildSignWhere(target.filters) })
      : target.ids.length;

  if (preCount === 0) done(returnTo);

  // Cascade (schema onDelete) clears status_history + tag assignments.
  await runWrite(returnTo, "bulkDelete", async () => {
    if (target.kind === "filter") {
      await prisma.sign.deleteMany({ where: buildSignWhere(target.filters) });
    } else {
      for (const part of chunk(target.ids, CHUNK)) {
        await prisma.sign.deleteMany({ where: { id: { in: part } } });
      }
    }
  });
  await auditBulk(session, "bulk.delete", `Deleted ${preCount} sign${preCount === 1 ? "" : "s"} (${targetDesc(target)})`);
  done(returnTo);
}

// Shared: a set-style column write across the whole selection. One statement for
// the filter case; chunked id-IN statements otherwise. Archived (soft-removed)
// rows are excluded from every branch — the BulkBar hides these actions on the
// Removed view, but that gate is client-only and a replayed POST bypasses it
// (#172).
async function updateManyTarget(
  target: BulkTarget,
  // Unchecked variant so a foreign-key scalar like zoneId can be set directly.
  data: Prisma.SignUncheckedUpdateManyInput,
): Promise<void> {
  if (target.kind === "filter") {
    await prisma.sign.updateMany({
      where: nonArchivedWhere(target),
      data,
    });
    return;
  }
  for (const part of chunk(target.ids, CHUNK)) {
    await prisma.sign.updateMany({
      where: { id: { in: part }, status: { not: ARCHIVED_STATUS } },
      data,
    });
  }
}

async function readTagId(fd: FormData, returnTo: string): Promise<number> {
  const tagId = Number(fd.get("tagId"));
  if (!Number.isInteger(tagId) || tagId <= 0) fail(returnTo, "Choose a tag.");
  const tag = await prisma.signTag.findUnique({
    where: { id: tagId },
    select: { id: true, slug: true },
  });
  if (!tag) fail(returnTo, "Selected tag no longer exists.");
  // System tags (e.g. `master-sheet`) are internal scoping markers — never
  // bulk-add/removable, so they can't be cleared and drop signs out of reconcile.
  if (isSystemTag(tag.slug)) {
    fail(returnTo, "That tag is managed by the system and can't be changed here.");
  }
  return tagId;
}
