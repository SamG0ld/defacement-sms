"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { requireRole, requireSession } from "@/lib/rbac";
import type { Prisma, SignStatus } from "@/app/generated/prisma/client";

import {
  DEPLOYMENT_SLOTS,
  SIGN_STATUSES,
  buildSignWhere,
  stampsForStatus,
  type SignFilters,
} from "./_lib";

// ---------------------------------------------------------------------------
// Bulk operations over a selection made on the /signs list. A selection is
// EITHER an explicit list of sign ids (the checked rows) OR "every row matching
// the current filter" — the latter lets a filtered set larger than one page be
// acted on without shipping a huge id list. Both resolve to a Prisma where.
//
// Permissions mirror the single-sign paths: status is open to any active user
// (floor staff advance signs), while zone/slot/tag/delete edit the same fields
// updateSign/deleteSign gate behind `lead`, so bulk does too.
// ---------------------------------------------------------------------------

// Reject pathological explicit selections so a hand-built form can't ask us to
// bind hundreds of thousands of ids in a single IN list.
const MAX_EXPLICIT_IDS = 10_000;
// Keep each updateMany/createMany under Postgres' 65,535 bind-parameter ceiling
// (history rows are ~5 params each → 5k rows ≈ 25k params, safe headroom).
const CHUNK = 5_000;

type BulkTarget =
  | { kind: "ids"; ids: number[] }
  | { kind: "filter"; filters: SignFilters };

function readFilters(fd: FormData): SignFilters {
  const get = (k: string): string | undefined => {
    const v = fd.get(k);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return {
    status: get("status"),
    zone: get("zone"),
    tag: get("tag"),
    slot: get("slot"),
    type: get("type"),
    q: get("q"),
    due: get("due"),
  };
}

// Parse the selection the BulkBar posted. Throws (via fail) on an empty/oversized
// explicit selection.
function readTarget(fd: FormData, returnTo: string): BulkTarget {
  if (fd.get("allMatching") === "1") {
    return { kind: "filter", filters: readFilters(fd) };
  }
  const raw = fd.get("ids");
  let ids: number[] = [];
  if (typeof raw === "string" && raw.length > 0) {
    // Bound the payload BEFORE JSON.parse so a giant array can't be fully
    // materialized just to be rejected by the count cap below. 10k ids of
    // up-to-7 digits + commas fit comfortably under 100k chars.
    if (raw.length > 100_000) fail(returnTo, "Selection is too large.");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
    } catch {
      fail(returnTo, "Could not read the selection.");
    }
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) fail(returnTo, "No signs selected.");
  if (ids.length > MAX_EXPLICIT_IDS) {
    fail(returnTo, `Too many signs selected (max ${MAX_EXPLICIT_IDS}).`);
  }
  return { kind: "ids", ids };
}

// where for the whole selection (used by set-style updateMany / deleteMany).
function targetWhere(target: BulkTarget): Prisma.SignWhereInput {
  return target.kind === "ids"
    ? { id: { in: target.ids } }
    : buildSignWhere(target.filters);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Resolve the affected ids (+ current status) for paths that need per-row work
// (status history, tag inserts). Selects only id/status so even a large set is
// a cheap read; writes are still batched.
async function resolveRows(
  target: BulkTarget,
  extra?: Prisma.SignWhereInput,
): Promise<{ id: number; status: SignStatus }[]> {
  const where: Prisma.SignWhereInput = extra
    ? { AND: [targetWhere(target), extra] }
    : targetWhere(target);
  return prisma.sign.findMany({ where, select: { id: true, status: true } });
}

// Only allow returning to an in-app /signs view. A bare startsWith("/signs")
// prefix check would accept "/signsEVIL" or a backslash/protocol-relative trick
// fed straight into redirect(); require the next char after /signs to be a path
// boundary (/, ?, #, or end) and reject backslashes and "//".
function safeReturnTo(fd: FormData): string {
  const r = fd.get("returnTo");
  if (typeof r !== "string") return "/signs";
  if (r.includes("\\") || r.startsWith("//")) return "/signs";
  return /^\/signs(?:[/?#]|$)/.test(r) ? r : "/signs";
}

function fail(returnTo: string, message: string): never {
  const sep = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${sep}error=${encodeURIComponent(message)}`);
}

function done(returnTo: string): never {
  revalidatePath("/signs");
  redirect(returnTo);
}

// Human-readable selection size for the audit detail without an extra count
// query (exact counts are passed in where a path already resolved its rows).
function targetDesc(target: BulkTarget): string {
  return target.kind === "ids"
    ? `${target.ids.length} selected sign${target.ids.length === 1 ? "" : "s"}`
    : "all signs matching the current filter";
}

// One audit row per bulk operation (the per-sign StatusHistory is separate).
// Best-effort via recordAudit, so it never blocks the op it records.
async function auditBulk(
  session: { user: { id: string; email?: string | null } },
  action: string,
  detail: string,
): Promise<void> {
  await recordAudit({
    action,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail,
  });
}

// Run the DB writes with a friendly failure redirect (matches the create/update
// ergonomics in actions.ts) instead of a raw error page on a mid-loop fault.
// fail() lives in the catch so its redirect throw is never re-caught here.
async function runWrite(
  returnTo: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[bulk] ${label} failed`, err);
    fail(returnTo, "Could not apply the change. Please try again.");
  }
}

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
