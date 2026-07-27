"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { logError } from "@/lib/log";
import { parseCsv } from "@/lib/csv";
import { MASTER_SHEET_TAG } from "@/lib/tags";
import { departmentTagFromSlugs } from "@/lib/con-config";
import { Prisma } from "@/app/generated/prisma/client";

import {
  tooManyRows,
  type MappingContext,
  type SignData,
} from "../import/_map";
import { buildMasterPreview } from "../import/_parsers/master";
import {
  FIELD_LABELS,
  identityOf,
  isSockCategory,
  MAX_LISTED_FAILED_IDS,
  reconcile,
  RECONCILE_FIELDS,
  type AppSign,
  type ReconcileField,
  type ReconcileResult,
  type ReconcileSnapshot,
  type SheetItem,
  type UpdateChange,
} from "@/lib/reconcile";

// Mirror the importer's 5 MB guard so the reconcile upload can't blow memory.
const MAX_CSV_BYTES = 5_000_000;

// Prisma's default interactive-transaction timeout is 5s and lib/db.ts sets no
// transactionOptions, so a large-but-legitimate apply used to be able to abort
// wholesale on remote round-trips instead of applying. 30s comfortably covers one
// CHANGE_CHUNK of updates (or the adds' three bulk statements) with headroom for a
// cold database compute. Deliberately NOT a single huge timeout over the whole batch:
// an interactive transaction holds row locks for its entire life, and the field PWA
// writes to these same sign rows during the con — see CHANGE_CHUNK.
// maxWait is raised from Prisma's 2s default to match the pg pool's own 6s
// connectionTimeoutMillis (lib/db.ts): the pool is capped at 3 connections and the
// field PWA competes for them, so leaving Prisma's ceiling TIGHTER than the pool's
// would abort a chunk at 2s that the pool would have served at 3-4s. That matters
// more now than it would have for one big transaction — an apply makes one
// $transaction call per chunk, so each is its own chance to lose that race, and any
// chunk failure stops the rest of the run. Going beyond 6s is what would buy nothing.
const APPLY_TX_OPTIONS = { timeout: 30_000, maxWait: 6_000 };

// Changes are applied in bounded transactions rather than one batch-wide one. Each
// row is its own round trip, so a full-sheet resync (the CSV re-parse caps at
// MAX_IMPORT_ROWS) would otherwise hold locks on every sign it had touched for the
// whole run, against a pool of 3 connections — long enough to stall a volunteer
// marking a sign deployed from the floor. 100 rows bounds that window to a couple of
// seconds. Partial application is safe and already the model here: reconcile re-diffs
// against the live DB, so re-running it simply picks up whatever didn't land.
//
// That safety rests on RECONCILE_FIELDS being a single per-row column with no
// cross-row invariant — every intermediate state (this sign's new text, that one's
// old) is a legitimate DB state. If a second reconciled field is ever added that must
// move together with signText, revisit chunking before adding it.
const CHANGE_CHUNK = 100;

// The field-scoped UPDATE payload, built FROM RECONCILE_FIELDS (just signText) so it
// can never drift from the reconciled set and can never reach a team-owned column.
function sheetOwnedUpdate(d: SignData): Prisma.SignUpdateManyMutationInput {
  return Object.fromEntries(
    RECONCILE_FIELDS.map((f) => [f, d[f]]),
  ) as Prisma.SignUpdateManyMutationInput;
}

// A sign's reconcile identity derived from stored columns. Mirrors
// loadSheetSourcedSigns' coalesce so a row read back from the DB keys the same way
// the diff did.
function identityOfRow(row: {
  itemId: string;
  sheetName: string | null;
  signText: string;
  category: string;
}): string {
  return identityOf(
    row.itemId,
    row.sheetName ?? row.signText,
    isSockCategory(row.category),
  );
}

// Cause-agnostic on purpose: a change can miss because its sign was deleted mid-batch
// OR because a chunk's transaction failed outright. Naming one of those would tell a
// lead (or an on-call engineer) the wrong story for the other.
function describeFailedIds(ids: number[]): string {
  if (ids.length === 0) return "";
  const shown = ids
    .slice(0, MAX_LISTED_FAILED_IDS)
    .map((id) => `#${id}`)
    .join(", ");
  const rest = ids.length - MAX_LISTED_FAILED_IDS;
  return ` (did not land: ${shown}${rest > 0 ? ` +${rest} more` : ""})`;
}

export type ReconcilePreview = {
  headerError: string | null;
  result: ReconcileResult;
  invalid: number; // parser-invalid rows, excluded from the diff
  notices: string[];
};

const acceptedSchema = z.object({
  adds: z.array(z.string().max(400)).max(5000),
  changes: z.array(z.string().max(400)).max(5000),
});

export type ReconcileApplyResult = {
  added: number;
  changed: number;
  failed: number;
  // Sign ids from the accepted CHANGES that didn't land — either the sign was deleted
  // out from under the batch, or its chunk's transaction failed. Surfaced so a lead
  // can see exactly which corrections to re-apply instead of an opaque count.
  failedIds: number[];
  // Accepted ADDS the database already had (dropped by skipDuplicates against the
  // sheet-identity index). Not a failure — but not silent either: without this the
  // gap between what the lead accepted and what was written would leave no trace.
  skippedAdds: number;
};

function emptyResult(): ReconcileResult {
  return {
    adds: [],
    changes: [],
    removes: [],
    ambiguous: [],
    deptChanges: [],
    unchanged: 0,
    counts: {
      add: 0,
      change: 0,
      remove: 0,
      ambiguous: 0,
      deptChange: 0,
      unchanged: 0,
    },
  };
}

function snapshotFromSignData(d: SignData): ReconcileSnapshot {
  return { signText: d.signText };
}

// The master parser matches on identity, so BOTH of the importer's DB-dedup sets
// (existingKeys / archivedKeys) are left empty — every parseable row comes back
// valid/invalid and we filter invalid out; reconcile does its own identity diff.
// tagSlugs comes back fully resolved (incl. `master-sheet`), so no extra query is
// needed here.
async function loadParseContext(): Promise<MappingContext> {
  const [zones, tags] = await Promise.all([
    prisma.zone.findMany({ select: { id: true, zoneCode: true } }),
    prisma.signTag.findMany({ select: { slug: true } }),
  ]);
  return {
    zoneByCode: new Map(zones.map((z) => [z.zoneCode.toUpperCase(), z.id])),
    tagSlugs: new Set(tags.map((t) => t.slug)),
    existingKeys: new Set<string>(),
    archivedKeys: new Set<string>(),
    liveSheetIdentities: new Set<string>(),
  };
}

// One parseable sheet row: its full create payload (for adds) alongside the engine's
// SheetItem (for the diff), keyed by identity.
type ParsedSheet = {
  items: SheetItem[];
  byIdentity: Map<string, { data: SignData; tagSlugs: string[]; line: number }>;
  invalid: number;
  notices: string[];
  headerError: string | null;
};

async function parseSheet(csvText: string): Promise<ParsedSheet> {
  const empty: ParsedSheet = {
    items: [],
    byIdentity: new Map(),
    invalid: 0,
    notices: [],
    headerError: null,
  };

  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return { ...empty, headerError: "File too large (max 5 MB)." };
  }
  const rows = parseCsv(csvText);
  const capped = tooManyRows(rows.length);
  if (capped) return { ...empty, headerError: capped.headerError };

  const ctx = await loadParseContext();
  const preview = buildMasterPreview(rows, ctx);
  if (preview.headerError) {
    return { ...empty, headerError: preview.headerError };
  }

  const items: SheetItem[] = [];
  const byIdentity = new Map<
    string,
    { data: SignData; tagSlugs: string[]; line: number }
  >();
  let invalid = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const row of preview.rows) {
    if (row.status === "invalid") {
      invalid += 1;
      continue;
    }
    const isSock = isSockCategory(row.data.category);
    // sheetName is always set by the master parser; coalesce for the type only.
    const sheetName = row.data.sheetName ?? row.data.signText;
    const identity = identityOf(row.data.itemId, sheetName, isSock);
    // Two sheet rows resolving to the same identity (an accidental copy-paste in the
    // sheet) would otherwise double-create on apply and collide on the UI key. First
    // row wins; the rest are collapsed and reported.
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    items.push({
      identity,
      line: row.line,
      itemId: row.data.itemId,
      sheetName,
      signText: row.data.signText,
      isSock,
      deptTag: departmentTagFromSlugs(row.tagSlugs),
      snapshot: snapshotFromSignData(row.data),
    });
    byIdentity.set(identity, {
      data: row.data,
      tagSlugs: row.tagSlugs,
      line: row.line,
    });
  }

  const notices = [...(preview.notices ?? [])];
  if (duplicates > 0) {
    notices.push(
      `Collapsed ${duplicates} duplicate sheet row${
        duplicates === 1 ? "" : "s"
      } (same room + name).`,
    );
  }

  return { items, byIdentity, invalid, notices, headerError: null };
}

// Master-sheet signs only: real (not test) and carrying the `master-sheet` tag — so
// an upstream deletion never flags, and an apply never touches, a sign that didn't
// come from Nikita's sheet (all-venue standing signs, hand-added wayfinding).
async function loadSheetSourcedSigns(): Promise<AppSign[]> {
  const signs = await prisma.sign.findMany({
    where: {
      isTestData: false,
      tagAssignments: { some: { tag: { slug: MASTER_SHEET_TAG } } },
    },
    select: {
      id: true,
      itemId: true,
      signText: true,
      sheetName: true,
      category: true,
      tagAssignments: { select: { tag: { select: { slug: true } } } },
    },
    // Stable order so the Ambiguous section's signId lists are deterministic.
    orderBy: { id: "asc" },
  });

  return signs.map((s) => {
    const isSock = isSockCategory(s.category);
    const sheetName = s.sheetName ?? s.signText;
    return {
      id: s.id,
      identity: identityOf(s.itemId, sheetName, isSock),
      itemId: s.itemId,
      sheetName,
      signText: s.signText,
      isSock,
      deptTag: departmentTagFromSlugs(
        s.tagAssignments.map((a) => a.tag.slug),
      ),
      snapshot: { signText: s.signText },
    };
  });
}

export async function previewReconcile(
  csvText: string,
): Promise<ReconcilePreview> {
  const session = await requireRole("lead");
  const { success } = await checkActionRateLimit(`reconcile:${session.user.id}`);
  if (!success) {
    return {
      headerError: "Too many attempts. Wait a minute and try again.",
      result: emptyResult(),
      invalid: 0,
      notices: [],
    };
  }

  const sheet = await parseSheet(csvText);
  if (sheet.headerError) {
    return {
      headerError: sheet.headerError,
      result: emptyResult(),
      invalid: 0,
      notices: [],
    };
  }

  const appSigns = await loadSheetSourcedSigns();
  const result = reconcile(sheet.items, appSigns);

  return {
    headerError: null,
    result,
    invalid: sheet.invalid,
    notices: sheet.notices,
  };
}

// Compact human-readable field deltas for the audit trail.
function describeChange(fields: { field: ReconcileField }[]): string {
  return fields.map((f) => FIELD_LABELS[f.field]).join(", ");
}

// Per-change audit rows for the changes a chunk committed. Written PER CHUNK, not
// once after the loop: chunks commit progressively, so a process death late in a long
// run would otherwise leave every earlier committed change with no audit row at all.
// Outside the transaction and best-effort, like recordAudit — a logging failure never
// rolls back an applied change.
async function auditAppliedChanges(
  actor: { id: string; email: string | null },
  sheet: ParsedSheet,
  landed: UpdateChange[],
): Promise<void> {
  if (landed.length === 0) return;
  const rows: Prisma.AuditLogCreateManyInput[] = landed.map((c) => ({
    action: "signs.reconcile",
    actorId: actor.id,
    actorEmail: actor.email,
    detail: `Reconciled sign #${c.signId} "${
      sheet.byIdentity.get(c.identity)!.data.signText
    }" from sheet: ${describeChange(c.fields)}`,
  }));
  try {
    await prisma.auditLog.createMany({ data: rows });
  } catch (err) {
    logError("signs.reconcile.audit", err);
  }
}

export async function applyReconcile(
  csvText: string,
  accepted: { adds: string[]; changes: string[] },
): Promise<ReconcileApplyResult> {
  const session = await requireRole("lead");
  const { success } = await checkActionRateLimit(`reconcile:${session.user.id}`);
  if (!success) throw new Error("rate-limited");

  const parsedAccepted = acceptedSchema.safeParse(accepted);
  if (!parsedAccepted.success) throw new Error("bad-request");
  const acceptAdds = new Set(parsedAccepted.data.adds);
  const acceptChanges = new Set(parsedAccepted.data.changes);

  // Re-parse + re-diff server-side: the client only chooses which identities to
  // accept; it can never inject field values. The changeset applied is the one the
  // server computes from the CSV + the live DB right now.
  const sheet = await parseSheet(csvText);
  if (sheet.headerError) throw new Error("parse-failed");
  const appSigns = await loadSheetSourcedSigns();
  const result = reconcile(sheet.items, appSigns);

  const addsToApply = result.adds.filter((a) => acceptAdds.has(a.identity));
  const changesToApply = result.changes.filter((c) =>
    acceptChanges.has(c.identity),
  );

  const changedBy = session.user.email ?? session.user.id;
  let added = 0;
  let changed = 0;
  let failed = 0;
  let failedIds: number[] = [];
  let skippedAdds = 0;

  // --- Adds: create new signs (reuse the importer's insert shape). The payload
  // carries sheetName + the `master-sheet` tag (from the parser), so a reconcile-added
  // sign is itself in scope for future reconciles. ---
  if (addsToApply.length > 0) {
    const tagRows = await prisma.signTag.findMany({
      select: { id: true, slug: true },
    });
    const tagIdBySlug = new Map(tagRows.map((t) => [t.slug, t.id]));

    // Hoisted above the try so a failure is attributed to the rows actually
    // attempted — addsToApply can (in principle) hold an identity that produced no
    // payload, and counting those as failures over-reports to the lead.
    const payloads = addsToApply
      .map((a) => sheet.byIdentity.get(a.identity))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    // Payload by sheet identity, so each created row is matched back to its OWN
    // source rather than by array position. parseSheet already collapses duplicate
    // sheet rows, so identities are unique across payloads. Positional pairing was
    // load-bearing on an undocumented createManyAndReturn ordering guarantee AND
    // breaks outright under skipDuplicates below, which drops rows from the result.
    const payloadByIdentity = new Map(
      payloads.map((p) => [
        identityOfRow({
          itemId: p.data.itemId,
          sheetName: p.data.sheetName,
          signText: p.data.signText,
          category: p.data.category,
        }),
        p,
      ]),
    );

    const signData: Prisma.SignCreateManyInput[] = payloads.map((p) => ({
      ...p.data,
      status: "pending",
      isTestData: false,
    }));

    try {
      added = await prisma.$transaction(async (tx) => {
        const created = await tx.sign.createManyAndReturn({
          data: signData,
          // Backed by the partial unique index on (item_id, sheet_name, category)
          // WHERE is_test_data = false. A concurrent/repeat apply that already
          // inserted this identity makes the row a no-op here instead of
          // double-creating the sign (or throwing away the whole batch). Prisma emits
          // an arbiter-less ON CONFLICT DO NOTHING, so this would also swallow a
          // future unique index on `signs` — the skippedAdds count below is what
          // keeps any such drop visible rather than silent.
          skipDuplicates: true,
          select: {
            id: true,
            itemId: true,
            sheetName: true,
            signText: true,
            category: true,
          },
        });
        const tagData: Prisma.SignTagAssignmentCreateManyInput[] = [];
        const historyData: Prisma.StatusHistoryCreateManyInput[] = [];
        for (const c of created) {
          const payload = payloadByIdentity.get(identityOfRow(c));
          if (!payload) continue;
          for (const slug of payload.tagSlugs) {
            const tagId = tagIdBySlug.get(slug);
            if (tagId !== undefined) tagData.push({ signId: c.id, tagId });
          }
          historyData.push({
            signId: c.id,
            oldStatus: null,
            newStatus: "pending",
            changedBy,
            notes: "Added via sheet reconcile",
          });
        }
        await tx.statusHistory.createMany({ data: historyData });
        if (tagData.length > 0) {
          await tx.signTagAssignment.createMany({
            data: tagData,
            skipDuplicates: true,
          });
        }
        return created.length;
      }, APPLY_TX_OPTIONS);
      // Rows the index already had. Reported separately from `failed` — nothing went
      // wrong, but the lead accepted more adds than were written and deserves to know.
      skippedAdds = payloads.length - added;
    } catch (err) {
      logError("signs.reconcile.add", err);
      failed += payloads.length;
    }
  }

  // --- Changes: field-scoped UPDATE of signText only, applied in bounded atomic
  // chunks. sheetOwnedUpdate() is built from RECONCILE_FIELDS, so the write
  // physically cannot reach a team-owned column
  // (size/notes/placement/status/QM/deploy/pins/photos). ---
  const applied = changesToApply.filter((c) => sheet.byIdentity.has(c.identity));
  if (applied.length > 0) {
    const landed: UpdateChange[] = [];
    const skippedIds: number[] = [];
    let processed = 0;

    for (let i = 0; i < applied.length; i += CHANGE_CHUNK) {
      const part = applied.slice(i, i + CHANGE_CHUNK);
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          const ok: UpdateChange[] = [];
          const missing: number[] = [];
          for (const c of part) {
            // updateMany, NOT update: a sign deleted between the fresh scope read
            // above and this write comes back as { count: 0 } instead of throwing
            // P2025. That keeps one concurrently-deleted sign costing its own row
            // only — the previous `update` threw out of the transaction callback and
            // rolled back every other accepted change in the batch. (A per-row
            // try/catch would not be a safe substitute: a statement that errors
            // inside a Postgres transaction aborts it, so resuming would need
            // SAVEPOINTs. updateMany simply never errors here.)
            const { count } = await tx.sign.updateMany({
              where: { id: c.signId },
              data: sheetOwnedUpdate(sheet.byIdentity.get(c.identity)!.data),
            });
            if (count === 1) ok.push(c);
            else missing.push(c.signId);
          }
          return { ok, missing };
        }, APPLY_TX_OPTIONS);

        landed.push(...outcome.ok);
        skippedIds.push(...outcome.missing);
        processed += part.length;
        await auditAppliedChanges(
          { id: session.user.id, email: session.user.email ?? null },
          sheet,
          outcome.ok,
        );
      } catch (err) {
        // This chunk rolled back. Earlier chunks are already committed and stay
        // committed — stop here and report the remainder as not landed.
        logError("signs.reconcile.change", err);
        break;
      }
    }

    changed = landed.length;
    // Everything the loop never got to (the failed chunk and any chunk after it)
    // plus the individually-missing rows. Correct whether or not a chunk threw:
    // on a clean run `unprocessed` is empty.
    const unprocessed = applied.slice(processed);
    failedIds = [...skippedIds, ...unprocessed.map((c) => c.signId)];
    failed += failedIds.length;

    // Per-change audit rows for the changes that actually landed, bulk-inserted
    // after the writes. Best-effort, like recordAudit — a logging failure never
    // rolls back an applied change.
    if (landed.length > 0) {
      const auditRows: Prisma.AuditLogCreateManyInput[] = landed.map((c) => ({
        action: "signs.reconcile",
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        detail: `Reconciled sign #${c.signId} "${
          sheet.byIdentity.get(c.identity)!.data.signText
        }" from sheet: ${describeChange(c.fields)}`,
      }));
      try {
        await prisma.auditLog.createMany({ data: auditRows });
      } catch (err) {
        logError("signs.reconcile.audit", err);
      }
    }
  }

  if (added > 0 || changed > 0) revalidatePath("/signs");

  // Only record a run-summary when something actually happened — a direct no-op call
  // shouldn't leave a content-free audit row.
  if (added > 0 || changed > 0 || failed > 0 || skippedAdds > 0) {
    await recordAudit({
      action: "signs.reconcile",
      actorId: session.user.id,
      actorEmail: session.user.email,
      detail: `Sheet reconcile: ${added} added, ${changed} changed${
        failed > 0 ? `, ${failed} failed` : ""
      }${
        skippedAdds > 0 ? `, ${skippedAdds} already existed (skipped)` : ""
      }${describeFailedIds(failedIds)}`,
    });
  }

  return { added, changed, failed, failedIds, skippedAdds };
}
