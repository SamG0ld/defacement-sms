"use server";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import type { SignStatus } from "@/app/generated/prisma/client";

import { ARCHIVABLE_STATUSES, ARCHIVED_STATUS } from "./_lib";
import {
  CHUNK,
  assertMutateBudget,
  auditBulk,
  chunk,
  done,
  doneWithNotice,
  fail,
  lockSigns,
  readTarget,
  resolveRows,
  runWrite,
  safeReturnTo,
} from "./_bulk-shared";

// ---------------------------------------------------------------------------
// Soft-remove ("archive") + restore for the DC34 per-size record engine. A
// removed sign transitions INTO the `archived` status (buildSignWhere then hides
// it from every default view, count, and export); its preview blob + tag
// assignments are KEPT so a restore is clean. Selection reuses the same
// filter/id target machinery every other bulk action uses — so "remove all
// training" is just Remove over the ?tag=training view.
//
// v1 eligibility: ONLY pending/generated signs are removable. A printed+ sign
// has a physical presence + a field-sync footprint, so it is skipped (and the
// count reported), never silently pulled from the record.
// ---------------------------------------------------------------------------

const isArchivable = (s: SignStatus): boolean =>
  (ARCHIVABLE_STATUSES as readonly SignStatus[]).includes(s);

// The master-sheet identity the #263 partial unique index is built on:
// (item_id, sheet_name, category) WHERE is_test_data = false AND sheet_name IS
// NOT NULL AND status <> 'archived'. JSON tuple, not a join, so a value
// containing the separator can't realign at a field boundary.
const identityKey = (
  itemId: string,
  sheetName: string | null,
  category: string,
): string => JSON.stringify([itemId, sheetName, category]);

// How many blocked item IDs to name in the operator notice before summarizing.
const NAMED_BLOCKED_LIMIT = 5;

export async function bulkArchive(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);

  // Resolve the targeted signs (buildSignWhere already drops already-archived
  // rows for a filter target), then split eligible (pending/generated) from the
  // skipped remainder (printed+).
  const rows = await resolveRows(target);
  const eligible = rows.filter((r) => isArchivable(r.status));
  const skipped = rows.length - eligible.length;

  if (eligible.length === 0) {
    fail(
      returnTo,
      skipped > 0
        ? `Nothing removed — ${skipped} sign${skipped === 1 ? " is" : "s are"} already printed (remove those through the lifecycle, not here).`
        : "No removable signs in the selection.",
    );
  }

  const changedBy = session.user.email ?? session.user.id;
  // One transaction per chunk: lock the chunk, re-read the CURRENT status under
  // the lock and re-apply the archivable rule, then archive + write history from
  // that locked set (#222). Without the lock a sign that reached `printed`
  // between the read above and the write would still be removed, and its history
  // row would claim it was archived from `generated`.
  let archived = 0;
  await runWrite(returnTo, "bulkArchive", async () => {
    for (const part of chunk(eligible, CHUNK)) {
      const ids = part.map((r) => r.id);
      await prisma.$transaction(
        async (tx) => {
          await lockSigns(tx, ids);
          const fresh = await tx.sign.findMany({
            where: { id: { in: ids } },
            select: { id: true, status: true },
          });
          const stillEligible = fresh.filter((r) => isArchivable(r.status));
          if (stillEligible.length === 0) return;
          archived += stillEligible.length;
          await tx.sign.updateMany({
            where: { id: { in: stillEligible.map((r) => r.id) } },
            data: { status: ARCHIVED_STATUS },
          });
          await tx.statusHistory.createMany({
            data: stillEligible.map((r) => ({
              signId: r.id,
              oldStatus: r.status,
              newStatus: ARCHIVED_STATUS,
              changedBy,
              notes: "Removed from per-size record",
            })),
          });
        },
        { timeout: 30_000 },
      );
    }
  });

  // Counts reflect what actually committed, not the pre-transaction snapshot.
  const notRemoved = rows.length - archived;
  // `bulk.*` like every other bulk action in this slice — archive/restore are
  // selection-wide operations, not single-sign ones (#186).
  await auditBulk(
    session,
    "bulk.archive",
    `Removed ${archived} sign${archived === 1 ? "" : "s"} from the record` +
      (notRemoved > 0 ? ` (${notRemoved} skipped — not removable)` : ""),
  );

  // Surface the skipped-count to the operator even on success so a partial
  // removal is never silent; a clean removal just returns to the view.
  if (notRemoved > 0) {
    // Deliberately states the RULE rather than asserting why each row was left:
    // after the locked re-check, `notRemoved` folds the printed+ rows together
    // with anything a concurrent operator changed mid-run, and claiming all of
    // them were "already printed" would be a guess.
    doneWithNotice(
      returnTo,
      `Removed ${archived}; skipped ${notRemoved} sign${notRemoved === 1 ? "" : "s"} — only pending or generated signs can be removed.`,
    );
  }
  done(returnTo);
}

export async function bulkRestore(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);

  // One read; restore only the archived rows and report any non-archived ids
  // that were in the selection but skipped (mirrors bulkArchive's UX so a
  // partial restore from a stale selection is never silent).
  const all = await resolveRows(target);
  const rows = all.filter((r) => r.status === ARCHIVED_STATUS);
  if (rows.length === 0) fail(returnTo, "No removed signs in the selection.");

  const ids = rows.map((r) => r.id);

  const changedBy = session.user.email ?? session.user.id;
  // One transaction per chunk: lock the chunk, keep only the rows STILL archived
  // at write time, then group those by restore target so the write is one
  // updateMany per distinct status (#222). Without the lock, a sign restored by a
  // concurrent operator would be restored a second time here and get a duplicate
  // `archived → …` history row for a transition that never happened.
  let restored = 0;
  // Item IDs dropped because restoring them would collide on the master-sheet
  // identity index (#264). Split by cause, because the lead's next move differs:
  //   live  — a sign still in the record holds that identity; deal with it first.
  //   peer  — ANOTHER removed sign in this same selection holds it. Multiple
  //           tombstones on one identity is a legal steady state (remove →
  //           re-add → remove), but only ONE of them can come back.
  // Reported separately from the plain "wasn't removed" skips.
  const blockedByLive: string[] = [];
  const blockedByPeer: string[] = [];
  await runWrite(returnTo, "bulkRestore", async () => {
    for (const part of chunk(ids, CHUNK)) {
      await prisma.$transaction(
        async (tx) => {
          await lockSigns(tx, part);
          const fresh = await tx.sign.findMany({
            where: { id: { in: part }, status: ARCHIVED_STATUS },
            select: {
              id: true,
              itemId: true,
              sheetName: true,
              category: true,
              isTestData: true,
            },
          });
          if (fresh.length === 0) return;

          // #263 relaxed the sheet-identity unique index to exclude `archived`,
          // which is what lets a tombstone coexist with its re-added live twin.
          // The cost is that RESTORING that tombstone moves the row INTO the
          // index predicate — Postgres evaluates a partial predicate on UPDATE —
          // and raises P2002. The write below is one updateMany per chunk, so a
          // single colliding row would roll back up to CHUNK-1 legitimate
          // restores and report "please try again", advice that can never work.
          // Drop the collisions here instead and name them. Only rows the index
          // actually covers can collide; everything else restores unconditionally.
          const covered = fresh.filter(
            (r) => !r.isTestData && r.sheetName !== null,
          );
          const blockedIds = new Set<number>();
          if (covered.length > 0) {
            // Bounded lookup: narrow on the two indexed-ish columns, then match
            // the full (itemId, sheetName, category) tuple in memory rather than
            // binding a 5k-clause OR.
            const holders = await tx.sign.findMany({
              where: {
                status: { not: ARCHIVED_STATUS },
                isTestData: false,
                itemId: { in: [...new Set(covered.map((r) => r.itemId))] },
                sheetName: {
                  in: [...new Set(covered.map((r) => r.sheetName as string))],
                },
              },
              select: { itemId: true, sheetName: true, category: true },
            });
            const taken = new Set(
              holders.map((h) => identityKey(h.itemId, h.sheetName, h.category)),
            );
            // Identities claimed by an earlier row of THIS restore, tracked apart
            // from `taken` only so the notice can name the right cause.
            const claimedHere = new Set<string>();
            // Live holders are only half of it: the restore set can collide with
            // ITSELF. Two tombstones sharing an identity are legal while both are
            // archived (the index excludes them), so `holders` sees neither — but
            // restoring both in one updateMany moves both into the predicate at
            // once and raises the same P2002. Claim each identity as it's
            // accepted, so the first tombstone restores and the rest are named.
            for (const r of covered) {
              const key = identityKey(r.itemId, r.sheetName, r.category);
              if (taken.has(key)) {
                blockedIds.add(r.id);
                if (claimedHere.has(key)) blockedByPeer.push(r.itemId);
                else blockedByLive.push(r.itemId);
                continue;
              }
              taken.add(key);
              claimedHere.add(key);
            }
          }

          const restorable = fresh.filter((r) => !blockedIds.has(r.id));
          if (restorable.length === 0) return;
          restored += restorable.length;
          const freshIds = restorable.map((r) => r.id);

          // Prior status = the oldStatus of each sign's MOST-RECENT archive
          // transition. Read INSIDE the transaction, after the lock, so a sign
          // that was restored and re-archived from a different status in the
          // meantime lands where its CURRENT archive episode came from — not
          // where a pre-transaction snapshot said. One newest-first query for the
          // chunk; first row seen per sign wins.
          const history = await tx.statusHistory.findMany({
            where: { signId: { in: freshIds }, newStatus: ARCHIVED_STATUS },
            orderBy: { changedAt: "desc" },
            select: { signId: true, oldStatus: true },
          });
          const priorBySign = new Map<number, string>();
          for (const h of history) {
            if (!priorBySign.has(h.signId) && h.oldStatus) {
              priorBySign.set(h.signId, h.oldStatus);
            }
          }

          // Only pending/generated are ever a valid landing (that's all we
          // archive), so an unknown/missing prior falls back to `generated` — a
          // safe neutral.
          const byTarget = new Map<SignStatus, number[]>();
          for (const id of freshIds) {
            const prior = priorBySign.get(id);
            const restoreTo: SignStatus =
              prior && isArchivable(prior as SignStatus)
                ? (prior as SignStatus)
                : "generated";
            const arr = byTarget.get(restoreTo);
            if (arr) arr.push(id);
            else byTarget.set(restoreTo, [id]);
          }

          for (const [restoreTo, tids] of byTarget) {
            await tx.sign.updateMany({
              where: { id: { in: tids } },
              data: { status: restoreTo },
            });
            await tx.statusHistory.createMany({
              data: tids.map((id) => ({
                signId: id,
                oldStatus: ARCHIVED_STATUS,
                newStatus: restoreTo,
                changedBy,
                notes: "Restored to per-size record",
              })),
            });
          }
        },
        { timeout: 30_000 },
      );
    }
  });

  // Counts reflect what actually committed, not the pre-transaction snapshot.
  // Each skip reason is reported on its own, because the lead's next move differs
  // for all three (#264).
  const nameList = (items: string[]): string => {
    const named = items.slice(0, NAMED_BLOCKED_LIMIT).join(", ");
    const rest = items.length - Math.min(items.length, NAMED_BLOCKED_LIMIT);
    return rest > 0 ? `${named} and ${rest} more` : named;
  };
  const blocked = blockedByLive.length + blockedByPeer.length;
  const notRestored = all.length - restored - blocked;
  // `bulk.*` like every other bulk action in this slice (#186).
  await auditBulk(
    session,
    "bulk.restore",
    `Restored ${restored} sign${restored === 1 ? "" : "s"} to the record` +
      (blockedByLive.length > 0
        ? ` (${blockedByLive.length} blocked — identity already live)`
        : "") +
      (blockedByPeer.length > 0
        ? ` (${blockedByPeer.length} blocked — duplicate removed copies)`
        : "") +
      (notRestored > 0 ? ` (${notRestored} skipped — not removed)` : ""),
  );

  if (blocked > 0 || notRestored > 0) {
    const parts = [`Restored ${restored}`];
    if (blockedByLive.length > 0) {
      parts.push(
        `couldn't restore ${blockedByLive.length} sign${blockedByLive.length === 1 ? "" : "s"} (${nameList(blockedByLive)}) — a sign that is still in the record already uses that room, sheet name and item type. Remove or re-identify the live one first`,
      );
    }
    if (blockedByPeer.length > 0) {
      parts.push(
        `left ${blockedByPeer.length} removed sign${blockedByPeer.length === 1 ? "" : "s"} (${nameList(blockedByPeer)}) removed — another sign in this selection shares the same room, sheet name and item type, and only one of them can be in the record. Restore the rest one at a time if you want a different one back`,
      );
    }
    if (notRestored > 0) {
      parts.push(
        `skipped ${notRestored} sign${notRestored === 1 ? "" : "s"} that ${notRestored === 1 ? "was" : "were"} not removed`,
      );
    }
    doneWithNotice(returnTo, `${parts.join("; ")}.`);
  }
  done(returnTo);
}
