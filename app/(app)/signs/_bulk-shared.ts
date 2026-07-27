// Shared helpers for selection-based actions over the /signs list (bulk edits +
// generation). A selection is EITHER an explicit list of sign ids (the checked
// rows) OR "every row matching the current filter". Both resolve to a Prisma
// where. This module is intentionally NOT "use server" — it holds the plain
// helpers that "use server" action files (bulk-actions.ts / generate-actions.ts)
// can't export themselves (those files may export only async actions).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/log";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import type { Prisma, SignStatus } from "@/app/generated/prisma/client";

import { ARCHIVED_STATUS, buildSignWhere, type SignFilters } from "./_lib";

// Reject pathological explicit selections so a hand-built form can't ask us to
// bind hundreds of thousands of ids in a single IN list.
export const MAX_EXPLICIT_IDS = 10_000;
// Keep each updateMany/createMany under Postgres' 65,535 bind-parameter ceiling
// (history rows are ~5 params each → 5k rows ≈ 25k params, safe headroom).
export const CHUNK = 5_000;

export type BulkTarget =
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
    // category was silently dropped here while buildSignWhere + the list page
    // both honour it — so "Select all N matching → Generate/bulk" over a
    // category-filtered board rebuilt the WRONG (broader) set server-side. The
    // bulk bar posts it; forward it so the full-filtered-set path is exact.
    category: get("category"),
    q: get("q"),
    due: get("due"),
  };
}

// Parse the selection the BulkBar posted. Throws (via fail) on an empty/oversized
// explicit selection.
export function readTarget(fd: FormData, returnTo: string): BulkTarget {
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
export function targetWhere(target: BulkTarget): Prisma.SignWhereInput {
  return target.kind === "ids"
    ? { id: { in: target.ids } }
    : buildSignWhere(target.filters);
}

// targetWhere + "and not soft-removed" — the server-side mirror of the BulkBar's
// `{!onArchivedView && …}` render gate, which is client-only and so bypassable by
// a replayed/hand-crafted POST (#172). Needed for BOTH target kinds: an explicit
// `ids` selection never filtered on status at all, and a `filter` selection built
// on the Removed view resolves to `status = archived` by design (buildSignWhere
// treats it as a first-class filter value for that view).
//
// Use this for every mutating bulk path EXCEPT the three that legitimately act on
// removed rows: bulkDelete (hard delete is allowed to reach them), bulkArchive
// (already narrowed to pending/generated) and bulkRestore (archived IS its input).
// It's what keeps _lib.ts's stated invariant true — "the only way IN is archive,
// the only way OUT is restore".
export function nonArchivedWhere(target: BulkTarget): Prisma.SignWhereInput {
  return { AND: [targetWhere(target), { status: { not: ARCHIVED_STATUS } }] };
}

// Lock the given sign rows for the rest of `tx` so a check-then-write can't race
// a concurrent writer (#171/#222). ORDER BY id so two overlapping selections
// always take their locks in the same order and can't deadlock — the same idiom
// generateSelection and the lifecycle actions already use.
//
// Locks by id only; callers re-read whichever columns they need with `tx.sign.*`
// straight after. Under READ COMMITTED that follow-up statement takes a fresh
// snapshot, and since these rows are now locked, what it reads IS committed truth
// for the duration of the transaction.
export async function lockSigns(
  tx: Prisma.TransactionClient,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM signs WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Resolve the affected ids (+ current status) for paths that need per-row work
// (status history, tag inserts). Selects only id/status so even a large set is
// a cheap read; writes are still batched.
export async function resolveRows(
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
export function safeReturnTo(fd: FormData): string {
  const r = fd.get("returnTo");
  if (typeof r !== "string") return "/signs";
  if (r.includes("\\") || r.startsWith("//")) return "/signs";
  return /^\/signs(?:[/?#]|$)/.test(r) ? r : "/signs";
}

export function fail(returnTo: string, message: string): never {
  const sep = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${sep}error=${encodeURIComponent(message)}`);
}

// Per-actor backstop on the mutating actions — a role gate is not a throttle,
// and every write path here fans out to chunked updateMany/createMany against
// the max:3 pool. Fails open when Upstash is unconfigured (dev) or down.
export async function assertMutateBudget(
  session: { user: { id: string } },
  returnTo: string,
): Promise<void> {
  const { success } = await checkMutationRateLimit(session.user.id);
  if (!success) {
    fail(returnTo, "Too many changes at once — wait a minute and try again.");
  }
}

export function done(returnTo: string): never {
  revalidatePath("/signs");
  redirect(returnTo);
}

// Success redirect that also carries a one-line notice for the list to show
// (e.g. "removed 30; skipped 5 already-printed"). Same revalidate as done();
// the list renders `?notice=` as a neutral banner, distinct from `?error=`.
export function doneWithNotice(returnTo: string, notice: string): never {
  revalidatePath("/signs");
  const sep = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${sep}notice=${encodeURIComponent(notice)}`);
}

// Human-readable selection size for the audit detail without an extra count
// query (exact counts are passed in where a path already resolved its rows).
export function targetDesc(target: BulkTarget): string {
  return target.kind === "ids"
    ? `${target.ids.length} selected sign${target.ids.length === 1 ? "" : "s"}`
    : "all signs matching the current filter";
}

// One audit row per bulk operation (the per-sign StatusHistory is separate).
// Best-effort via recordAudit, so it never blocks the op it records.
export async function auditBulk(
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
export async function runWrite(
  returnTo: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError("signs.bulk", err, { label });
    // Two callers can collide with the master-sheet identity index added in
    // migration 20260724120000, each for its own reason and each needing its own
    // story. Both are named explicitly so a future P2002 elsewhere can't inherit a
    // confidently wrong one.
    //
    // bulkSetFormat writes `category`, the column in that index — a reformat
    // sweeping a master primary AND its sock into one format collides, since the
    // parser emits that pair sharing item_id + sheet_name and differing only by
    // category. "Try again" would never work for that, so name the real cause.
    if (label === "bulkSetFormat" && (err as { code?: string })?.code === "P2002") {
      fail(
        returnTo,
        "That would give two signs the same room, sheet name and item type — most " +
          "likely a sign and its sock being reformatted together. Narrow the " +
          "selection, or change one of the two signs first.",
      );
    }
    // bulkRestore is the second caller that can hit that index: #263 exempted
    // archived rows from it, so restoring a tombstone moves the row back INTO the
    // predicate and can collide with a live twin — or with a second tombstone on
    // the same identity being restored alongside it. bulkRestore pre-checks for
    // both inside its lock, so reaching here means the conflict appeared DURING
    // the run — a genuine race, and the one case where re-running actually works.
    // Deliberately does NOT claim "nothing was restored": restore commits one
    // transaction per 5,000-row chunk, so earlier chunks may already be committed.
    // Re-running is safe either way — restore only ever touches rows still
    // archived, so a committed chunk is a no-op the second time through.
    if (label === "bulkRestore" && (err as { code?: string })?.code === "P2002") {
      fail(
        returnTo,
        "Restore stopped partway: another sign now uses the same room, sheet name " +
          "and item type as one you're restoring. Re-run Restore — anything already " +
          "restored is left alone, and the conflicting sign will be listed and skipped.",
      );
    }
    fail(returnTo, "Could not apply the change. Please try again.");
  }
}
