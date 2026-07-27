"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { deletePrivateImage, putPrivateImage } from "@/lib/blob-image";
import { isValidFigmaUrl, figmaFileKey, canonicalizeFigmaUrl } from "@/lib/figma";
import {
  fetchFileDocument,
  fetchNodeImages,
  fetchRenderedImage,
  figmaToken,
} from "@/lib/figma-api";
import {
  flattenFigmaNodes,
  matchNodesToSigns,
  type PreviewMatch,
} from "@/lib/figma-match";
import { validateImageUpload } from "@/lib/image-upload";
import { logError, logWarn } from "@/lib/log";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { requireRole } from "@/lib/rbac";

import {
  formatBucketForSize,
  formatBucketOrder,
} from "@/lib/sign-format";

import { ARCHIVED_STATUS, stampsForStatus } from "./_lib";
import {
  CHUNK,
  assertMutateBudget,
  auditBulk,
  chunk,
  fail,
  nonArchivedWhere,
  readTarget,
  runWrite,
  safeReturnTo,
} from "./_bulk-shared";

// In-app generation orchestration. The app is the system-of-record for the
// generation lifecycle — it does NOT render the art (that's the Figma render
// step). "Generate" records who generated which signs when, flips them to
// `generated`, and links them to a GenerationBatch whose Figma file URL is
// captured back into the app after the render. Generation is a coordination
// task → lead+ (matching the zone/tag/delete bulk ops).

// Bounded-concurrency pool: run `worker` over `items` with at most `limit` in flight.
// Used by the preview importer so a slice's signs download without firing all of them as
// simultaneous Figma/Blob requests.
const PREVIEW_IMPORT_CONCURRENCY = 6;
// How many signs one client-driven import slice handles. The client calls the slice
// action repeatedly (offset += this) until `done`, so no single request approaches the
// route's 300s cap at ANY batch size — the structural fix for the 242-sign timeout.
const PREVIEW_IMPORT_SLICE = 50;

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const idx = next;
        next += 1;
        await worker(items[idx]);
      }
    },
  );
  await Promise.all(runners);
}

export async function generateSelection(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  await assertMutateBudget(session, returnTo);
  const target = readTarget(formData, returnTo);

  // Every targeted sign joins a batch; a StatusHistory row is recorded only for
  // those actually transitioning into `generated` (no no-op history). `size`
  // drives the split-by-format bucketing below.
  //
  // Archived (soft-removed) signs are excluded server-side (#172): this action
  // flips status to `generated` and links a batch, so without the guard a
  // selection made on the Removed view — or a replayed POST carrying archived ids
  // — would silently resurrect signs the team deliberately pulled from the
  // per-size record, with no `restored` trace. Removal is undone by Restore only.
  const rows = await prisma.sign.findMany({
    where: nonArchivedWhere(target),
    select: { id: true, status: true, size: true },
  });
  if (rows.length === 0) fail(returnTo, "No signs to generate.");

  // Split the selection into one batch per Format (single ≠ double — distinct
  // Figma files/text), off-format sizes collapsing into a single "Other /
  // custom" batch. Ordered by size so the created batches read in format order.
  const buckets = new Map<string, { label: string; rows: typeof rows }>();
  for (const r of rows) {
    const b = formatBucketForSize(r.size);
    const existing = buckets.get(b.key);
    if (existing) existing.rows.push(r);
    else buckets.set(b.key, { label: b.label, rows: [r] });
  }
  const orderedBuckets = [...buckets.entries()].sort(
    ([a], [b]) => formatBucketOrder(a) - formatBucketOrder(b),
  );

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();
  const stamps = stampsForStatus("generated", changedBy, now);
  // Accumulated from the in-tx status re-read below (not the stale pre-tx snapshot)
  // so the audit count reflects what actually transitioned.
  let newlyGenerated = 0;
  let batched = 0;
  const createdBatchIds: number[] = [];

  // One interactive transaction wraps EVERY per-format batch create + its chunk
  // writes, so a mid-loop failure rolls all of them back together (no partial
  // split leaving some formats batched and others not, and no orphan batch).
  await runWrite(returnTo, "generateSelection", async () => {
    await prisma.$transaction(
      async (tx) => {
        // Lock + re-read ALL targeted statuses once (FOR UPDATE, ordered by id
        // so overlapping selections can't deadlock): under READ COMMITTED a
        // plain re-read still races — two leads generating overlapping
        // selections could both read a sign as not-yet-generated before either
        // commits and each write a duplicate "→ generated" history row. The row
        // locks serialize the transactions, so `moving` (and the history's
        // oldStatus) reflect committed truth. One lock read covers every bucket.
        const allIds = rows.map((r) => r.id);
        const locked = await tx.$queryRaw<{ id: number; status: string }[]>`
          SELECT id, status FROM signs WHERE id = ANY(${allIds}) ORDER BY id FOR UPDATE`;
        const currentStatus = new Map(
          locked.map((s) => [s.id, s.status] as const),
        );
        // The archived exclusion has to survive the lock too, not just narrow the
        // pre-transaction read: a sign removed by a concurrent operator between
        // that read and this lock would otherwise still be flipped to `generated`
        // and linked into a print batch — the resurrect #172 exists to stop.
        const liveIds = new Set(
          locked
            .filter((s) => s.status !== ARCHIVED_STATUS)
            .map((s) => s.id),
        );

        for (const [, bucket] of orderedBuckets) {
          // Drive the write from the locked, still-live set — and skip the batch
          // entirely if nothing in this format survived, so a removal can't leave
          // an empty batch behind.
          const live = bucket.rows.filter((r) => liveIds.has(r.id));
          if (live.length === 0) continue;
          batched += live.length;

          const batch = await tx.generationBatch.create({
            data: {
              label: bucket.label,
              pipeline: "figma-mcp",
              signCount: live.length,
              createdById: session.user.id,
              createdByEmail: session.user.email ?? null,
            },
            select: { id: true },
          });
          createdBatchIds.push(batch.id);

          for (const part of chunk(live, CHUNK)) {
            const ids = part.map((r) => r.id);
            const moving = part.filter(
              (r) => currentStatus.get(r.id) !== "generated",
            );
            newlyGenerated += moving.length;
            await tx.sign.updateMany({
              where: { id: { in: ids } },
              data: {
                generationBatchId: batch.id,
                status: "generated",
                generationPipeline: "figma-mcp",
                ...stamps,
              },
            });
            if (moving.length > 0) {
              await tx.statusHistory.createMany({
                data: moving.map((r) => ({
                  signId: r.id,
                  oldStatus: currentStatus.get(r.id) ?? r.status,
                  newStatus: "generated",
                  changedBy,
                  notes: "Generation batch",
                })),
              });
            }
          }
        }
      },
      { timeout: 30_000 },
    );
  });

  const batchCount = createdBatchIds.length;
  // Counts come from the locked set, so the log reflects what actually committed
  // rather than the pre-transaction selection.
  await auditBulk(
    session,
    "sign.generate",
    `Generated ${batched} sign${batched === 1 ? "" : "s"}` +
      ` across ${batchCount} batch${batchCount === 1 ? "" : "es"} by size` +
      `${newlyGenerated < batched ? ` (${newlyGenerated} newly)` : ""}` +
      `${batched < rows.length ? ` (${rows.length - batched} skipped — removed)` : ""}` +
      `${batchCount > 0 ? ` (#${createdBatchIds.join(", #")})` : ""}`,
  );

  revalidatePath("/signs");
  revalidatePath("/signs/generate");
  // N batches now, so land on the index where they're all listed rather than a
  // single batch page.
  redirect("/signs/generate");
}

// Capture (or clear) the editable Figma file URL for a batch after the render.
export async function updateBatchFigmaUrl(
  batchId: number,
  formData: FormData,
): Promise<void> {
  await requireRole("lead");
  const back = `/signs/generate/${batchId}`;
  const raw = formData.get("figmaUrl");
  const url = typeof raw === "string" ? raw.trim() : "";

  // Empty clears the link; otherwise it must be a real https figma.com URL so a
  // stored URL can't become a stored-XSS link sink.
  if (url !== "" && !isValidFigmaUrl(url)) {
    redirect(
      `${back}?error=${encodeURIComponent("Enter a valid https://figma.com URL.")}`,
    );
  }

  // updateMany (not update) so a deleted batch is a friendly "not found" redirect
  // rather than an unhandled P2025 → 500. Store the URL canonicalized (host + kind +
  // key, dropping the ?t= share token, title slug, and node-id) so the same file
  // linked from two batches is one string — the by-size view and the reconcile
  // manifest both dedup files by exact URL string.
  const res = await prisma.generationBatch.updateMany({
    where: { id: batchId },
    data: { figmaUrl: url === "" ? null : canonicalizeFigmaUrl(url) },
  });
  if (res.count === 0) {
    redirect(`${back}?error=${encodeURIComponent("Batch not found.")}`);
  }
  revalidatePath(back);
  redirect(back);
}

// Delete a generation batch from the index. Safe by design: Sign.generationBatchId
// is onDelete: SetNull, so the batch's signs are PRESERVED — they only lose the
// "which batch generated me" pointer (previews live on the Sign, untouched). Used to
// clear test/cruft batches. lead+, audited, one batch per call. The bound int
// batchId is the only input; the form carries nothing else, so this takes no
// FormData (the bound zero-arg function is still a valid form `action`).
export async function deleteGenerationBatch(batchId: number): Promise<void> {
  const session = await requireRole("lead");
  const index = "/signs/generate";

  // Read first for the audit line + a friendly not-found.
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: { label: true, _count: { select: { signs: true } } },
  });
  if (!batch) {
    redirect(`${index}?error=${encodeURIComponent("Batch not found.")}`);
  }

  // deleteMany (not delete) so a concurrent delete is a friendly no-op, never an
  // unhandled P2025 → 500 — same reason updateBatchFigmaUrl uses updateMany. Signs
  // auto-unlink via the SetNull FK; no manual sign update.
  const res = await prisma.generationBatch.deleteMany({ where: { id: batchId } });

  // Only audit when THIS call did the delete: if another request removed the batch
  // between the read above and here, res.count is 0 — skip the audit so the same
  // deletion isn't logged twice. The end state (batch gone) is what both wanted.
  if (res.count > 0) {
    const n = batch._count.signs;
    await auditBulk(
      session,
      "batch.delete",
      `Deleted batch #${batchId}${batch.label ? ` (${batch.label})` : ""}` +
        ` — ${n} sign${n === 1 ? "" : "s"} unlinked`,
    );
  }

  revalidatePath(index);
  revalidatePath("/signs");
  redirect(index);
}

// Importer A: pull the rendered images for a batch straight from its Figma file
// and assign them as sign previews. The node↔sign mapping is by Item-ID prefix
// (the figma-mcp-signs naming contract) — see lib/figma-match.ts. Reuses B's
// storage/display layer (putPrivateImage + the preview route + the detail panel);
// this is just a different source. lead+, matching the other generation actions.
//
// Driven in SLICES by the batch page's client component: it calls
// importBatchPreviewsSlice(batchId, offset) repeatedly (offset += the returned
// processed count) until `done`. Slicing keeps every request bounded (~50 signs) so
// no single invocation approaches the route's 300s cap at any batch size — the fix
// for the 242-sign timeout. The action returns a serializable result (never
// redirect()) so the client can render a live progress bar and inline errors.

// One slice's outcome. Hard failures (auth-rate-limit, missing token/URL, a Figma
// fetch error) come back as { ok: false } so the client can surface them inline and
// offer a resume-from-offset retry; per-sign failures are non-fatal and counted.
export type PreviewSliceResult =
  | {
      ok: true;
      imported: number; // successful this slice
      failed: number; // per-sign failures this slice
      processed: number; // matched signs handled this slice (= nextOffset - offset)
      nextOffset: number; // offset to pass to the next call
      total: number; // matched.length — the progress-bar denominator
      totalSigns: number; // signs in the batch (matched + unmatched)
      unmatched: number; // signs with no Figma node
      done: boolean; // nextOffset >= total
    }
  | { ok: false; error: string; nextOffset: number };

// Resolve a batch to its ordered matched previews (+ coverage counts), or a friendly
// error string. Stateless and deterministic, so each slice re-derives the SAME ordered
// `matched` list and can safely index into it by offset. (The whole-document fetch +
// match repeats per slice; that's the cost of a stateless, resumable importer — each
// call stays self-contained and correct even if the batch is edited between slices.)
async function resolveBatchMatches(
  batchId: number,
): Promise<
  | {
      ok: true;
      fileKey: string;
      token: string;
      matched: PreviewMatch[];
      prevPaths: Map<number, string | null>;
      totalSigns: number;
      unmatched: number;
    }
  | { ok: false; error: string }
> {
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: {
      figmaUrl: true,
      // signText feeds the exact full-name match (disambiguates duplicate Item IDs);
      // orderBy makes the match order deterministic across slices and matches the batch
      // page / export queries (both sort [{itemId},{id}]) instead of relying on DB order.
      signs: {
        select: { id: true, itemId: true, signText: true, previewImagePath: true },
        orderBy: [{ itemId: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!batch) return { ok: false, error: "Batch not found." };

  const token = figmaToken();
  if (!token) return { ok: false, error: "Figma API token not configured." };
  if (!batch.figmaUrl) return { ok: false, error: "Save the Figma file link first." };
  const fileKey = figmaFileKey(batch.figmaUrl);
  if (!fileKey) return { ok: false, error: "Couldn't read the Figma file key." };

  const document = await fetchFileDocument(fileKey, token);
  const nodes = flattenFigmaNodes(document);
  const { matched, unmatchedSigns } = matchNodesToSigns(
    nodes,
    batch.signs.map((s) => ({
      id: s.id,
      itemId: s.itemId,
      signText: s.signText,
    })),
  );

  const prevPaths = new Map(
    batch.signs.map((s) => [s.id, s.previewImagePath] as const),
  );
  return {
    ok: true,
    fileKey,
    token,
    matched,
    prevPaths,
    totalSigns: batch.signs.length,
    unmatched: unmatchedSigns.length,
  };
}

export async function importBatchPreviewsSlice(
  batchId: number,
  offset: number,
): Promise<PreviewSliceResult> {
  const session = await requireRole("lead");

  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;

  // Rate-limit EVERY slice, not just the start — the action is client-callable, so
  // gating only offset 0 would let a caller skip the throttle by always passing
  // offset > 0 and hammer the expensive Figma-fetch + blob-write path. The 20/min
  // per-user bucket still clears any real run (242 signs = 5 slices; ~1000 signs
  // before it trips), and a run that ever trips just resumes from its offset (the
  // import is idempotent). One import ≈ a handful of tokens, not one.
  const { success } = await checkActionRateLimit(
    `figma-import:${session.user.id}`,
  );
  if (!success) {
    return {
      ok: false,
      error: "Too many imports — wait a minute and try again.",
      nextOffset: start,
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveBatchMatches>>;
  try {
    resolved = await resolveBatchMatches(batchId);
  } catch (err) {
    // A Figma document fetch / parse failure — surface it and let the client retry
    // this same slice (nextOffset unchanged).
    const message =
      err instanceof Error ? err.message : "Figma preview import failed.";
    return { ok: false, error: message.slice(0, 300), nextOffset: start };
  }
  if (!resolved.ok) return { ok: false, error: resolved.error, nextOffset: start };

  const { fileKey, token, matched, prevPaths, totalSigns, unmatched } = resolved;
  const total = matched.length;
  const slice = matched.slice(start, start + PREVIEW_IMPORT_SLICE);
  const nextOffset = Math.min(start + PREVIEW_IMPORT_SLICE, total);
  const done = nextOffset >= total;

  // Render only this slice's nodes (bounded work per request), then import them.
  let images: Record<string, string> = {};
  if (slice.length > 0) {
    try {
      images = await fetchNodeImages(
        fileKey,
        slice.map((m) => ({ id: m.nodeId, width: m.width, height: m.height })),
        token,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Figma image render failed.";
      return { ok: false, error: message.slice(0, 300), nextOffset: start };
    }
  }

  // Import each matched sign's preview: download → validate → store → point the Sign at
  // the new blob. Bounded concurrency; each sign is independent (own blob + row) and its
  // failure is caught in-worker so it never aborts the slice. Counters mutate safely: JS
  // is single-threaded between awaits.
  let imported = 0;
  let failed = 0;

  const importOne = async (m: PreviewMatch): Promise<void> => {
    const url = images[m.nodeId];
    if (!url) {
      // Known-reason skip — Figma returned no rendered image for this node.
      // Log it so the failure count isn't the only signal. (#76)
      logWarn("signs.preview-import-skipped", "no rendered image for node", {
        signId: m.signId,
        batchId,
        itemId: m.itemId,
        nodeId: m.nodeId,
      });
      failed += 1;
      return;
    }
    try {
      const bytes = await fetchRenderedImage(url);
      const valid = validateImageUpload(bytes);
      if (!valid.ok) {
        logWarn("signs.preview-import-skipped", "rendered image failed validation", {
          signId: m.signId,
          batchId,
          itemId: m.itemId,
          reason: valid.error,
        });
        failed += 1;
        return;
      }
      const prev = prevPaths.get(m.signId) ?? null;
      const pathname = await putPrivateImage(
        "sign-previews",
        String(m.signId),
        bytes,
        valid.image.contentType,
      );
      try {
        await prisma.sign.update({
          where: { id: m.signId },
          data: { previewImagePath: pathname, figmaInstanceNodeId: m.nodeId },
        });
      } catch (dbErr) {
        // DB write failed after the upload — delete the just-stored blob so a
        // failed import doesn't orphan paid storage (m17 #106), then rethrow to
        // the per-sign handler below (which counts it as failed).
        await deletePrivateImage(pathname);
        throw dbErr;
      }
      // Reclaim the replaced blob (best-effort, like the upload route).
      if (prev && prev !== pathname) await deletePrivateImage(prev);
      imported += 1;
    } catch (err) {
      // A per-sign failure must not abort the slice. The real cause (Blob quota,
      // P2002, CDN 503, timeout) is forwarded to Sentry + stderr so a 2 AM preview
      // failure is diagnosable without a redeploy. (m17 #70 / #76)
      logError("signs.preview-import-failed", err, {
        signId: m.signId,
        batchId,
        itemId: m.itemId,
      });
      failed += 1;
    }
  };

  await runPool(slice, PREVIEW_IMPORT_CONCURRENCY, importOne);

  const back = `/signs/generate/${batchId}`;
  revalidatePath(back);
  revalidatePath("/signs");

  // Audit once per completed run, with a server-side recount of the batch's previews
  // (never client-supplied numbers) so the log reflects committed truth and an
  // idempotent re-run reads sensibly ("N/total signs have previews"). Gated on
  // `start < total` too, so a crafted out-of-range offset (empty slice, done=true)
  // can't emit a no-op "import complete" audit row.
  if (done && start < total) {
    const withPreview = await prisma.sign.count({
      where: { generationBatchId: batchId, previewImagePath: { not: null } },
    });
    await auditBulk(
      session,
      "sign.import_previews",
      `Imported previews for batch #${batchId}: ${withPreview}/${totalSigns} sign` +
        `${totalSigns === 1 ? "" : "s"} now have previews` +
        (unmatched > 0
          ? `, ${unmatched} unmatched (no Figma node)`
          : "") +
        ".",
    );
  }

  return {
    ok: true,
    imported,
    failed,
    processed: slice.length,
    nextOffset,
    total,
    totalSigns,
    unmatched,
    done,
  };
}
