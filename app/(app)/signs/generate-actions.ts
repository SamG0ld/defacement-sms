"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { deletePrivateImage, putPrivateImage } from "@/lib/blob-image";
import { isValidFigmaUrl, figmaFileKey } from "@/lib/figma";
import {
  fetchFileDocument,
  fetchNodeImages,
  fetchRenderedImage,
  figmaToken,
} from "@/lib/figma-api";
import { flattenFigmaNodes, matchNodesToSigns } from "@/lib/figma-match";
import { validateImageUpload } from "@/lib/image-upload";
import { requireRole } from "@/lib/rbac";

import { stampsForStatus } from "./_lib";
import {
  CHUNK,
  auditBulk,
  chunk,
  fail,
  readTarget,
  resolveRows,
  runWrite,
  safeReturnTo,
} from "./_bulk-shared";

// In-app generation orchestration. The app is the system-of-record for the
// generation lifecycle — it does NOT render the art (that's the Figma render
// step). "Generate" records who generated which signs when, flips them to
// `generated`, and links them to a GenerationBatch whose Figma file URL is
// captured back into the app after the render. Generation is a coordination
// task → lead+ (matching the zone/tag/delete bulk ops).

export async function generateSelection(formData: FormData): Promise<void> {
  const session = await requireRole("lead");
  const returnTo = safeReturnTo(formData);
  const target = readTarget(formData, returnTo);

  // Every selected sign joins the batch; a StatusHistory row is recorded only
  // for those actually transitioning into `generated` (no no-op history).
  const rows = await resolveRows(target);
  if (rows.length === 0) fail(returnTo, "No signs to generate.");

  const changedBy = session.user.email ?? session.user.id;
  const now = new Date();
  const stamps = stampsForStatus("generated", changedBy, now);
  // Accumulated from the in-tx status re-read below (not the stale pre-tx snapshot)
  // so the audit count reflects what actually transitioned.
  let newlyGenerated = 0;

  // One interactive transaction wraps the batch create AND every chunk write, so
  // a mid-loop failure rolls the batch back too (no orphan batch with 0 signs).
  let batchId: number | undefined;
  await runWrite(returnTo, "generateSelection", async () => {
    await prisma.$transaction(
      async (tx) => {
        const batch = await tx.generationBatch.create({
          data: {
            pipeline: "figma-mcp",
            signCount: rows.length,
            createdById: session.user.id,
            createdByEmail: session.user.email ?? null,
          },
          select: { id: true },
        });
        batchId = batch.id;

        // Re-read statuses INSIDE the tx rather than trusting the pre-tx
        // resolveRows snapshot: two leads generating overlapping selections at
        // once would otherwise each write a duplicate "→ generated" history row
        // off the same stale read. Only signs not already generated move.
        const currentStatus = new Map(
          (
            await tx.sign.findMany({
              where: { id: { in: rows.map((r) => r.id) } },
              select: { id: true, status: true },
            })
          ).map((s) => [s.id, s.status] as const),
        );

        for (const part of chunk(rows, CHUNK)) {
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
      },
      { timeout: 30_000 },
    );
  });

  await auditBulk(
    session,
    "sign.generate",
    `Generated ${rows.length} sign${rows.length === 1 ? "" : "s"}` +
      `${newlyGenerated < rows.length ? ` (${newlyGenerated} newly)` : ""}` +
      `${batchId !== undefined ? ` (batch #${batchId})` : ""}`,
  );

  revalidatePath("/signs");
  revalidatePath("/signs/generate");
  redirect(batchId !== undefined ? `/signs/generate/${batchId}` : "/signs/generate");
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
  // rather than an unhandled P2025 → 500.
  const res = await prisma.generationBatch.updateMany({
    where: { id: batchId },
    data: { figmaUrl: url === "" ? null : url },
  });
  if (res.count === 0) {
    redirect(`${back}?error=${encodeURIComponent("Batch not found.")}`);
  }
  revalidatePath(back);
  redirect(back);
}

// Importer A: pull the rendered images for a batch straight from its Figma file
// and assign them as sign previews. The node↔sign mapping is by Item-ID prefix
// (the figma-mcp-signs naming contract) — see lib/figma-match.ts. Reuses B's
// storage/display layer (putPrivateImage + the preview route + the detail panel);
// this is just a different source. lead+, matching the other generation actions.
//
// NOTE on redirect(): Next's redirect() works by throwing, so it must never be
// called inside the try block (the catch would swallow it). Network/processing
// runs in the try; all redirects happen after it (success) or in the catch (hard
// failure). Per-sign failures are collected and never abort the batch.
export async function importBatchPreviews(batchId: number): Promise<void> {
  const session = await requireRole("lead");
  const back = `/signs/generate/${batchId}`;

  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: {
      figmaUrl: true,
      signs: { select: { id: true, itemId: true, previewImagePath: true } },
    },
  });
  if (!batch) redirect(`${back}?error=${encodeURIComponent("Batch not found.")}`);

  const token = figmaToken();
  if (!token) {
    redirect(
      `${back}?error=${encodeURIComponent("Figma API token not configured.")}`,
    );
  }
  if (!batch.figmaUrl) {
    redirect(
      `${back}?error=${encodeURIComponent("Save the Figma file link first.")}`,
    );
  }
  const fileKey = figmaFileKey(batch.figmaUrl);
  if (!fileKey) {
    redirect(
      `${back}?error=${encodeURIComponent("Couldn't read the Figma file key.")}`,
    );
  }

  let summary: string;
  try {
    const document = await fetchFileDocument(fileKey, token);
    const nodes = flattenFigmaNodes(document);
    const { matched, unmatchedSigns } = matchNodesToSigns(
      nodes,
      batch.signs.map((s) => ({ id: s.id, itemId: s.itemId })),
    );

    const images =
      matched.length > 0
        ? await fetchNodeImages(fileKey, matched.map((m) => m.nodeId), token)
        : {};

    let imported = 0;
    const failed: string[] = [];
    for (const m of matched) {
      const url = images[m.nodeId];
      if (!url) {
        failed.push(m.itemId);
        continue;
      }
      try {
        const bytes = await fetchRenderedImage(url);
        const valid = validateImageUpload(bytes);
        if (!valid.ok) {
          failed.push(m.itemId);
          continue;
        }
        const prev =
          batch.signs.find((s) => s.id === m.signId)?.previewImagePath ?? null;
        const pathname = await putPrivateImage(
          "sign-previews",
          String(m.signId),
          bytes,
          valid.image.contentType,
        );
        await prisma.sign.update({
          where: { id: m.signId },
          data: { previewImagePath: pathname, figmaInstanceNodeId: m.nodeId },
        });
        // Reclaim the replaced blob (best-effort, like the upload route).
        if (prev && prev !== pathname) await deletePrivateImage(prev);
        imported += 1;
      } catch {
        failed.push(m.itemId);
      }
    }

    summary =
      `Imported ${imported} preview${imported === 1 ? "" : "s"} from Figma` +
      (unmatchedSigns.length > 0
        ? `, ${unmatchedSigns.length} sign${unmatchedSigns.length === 1 ? "" : "s"} unmatched`
        : "") +
      (failed.length > 0 ? `, ${failed.length} failed` : "") +
      ".";
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Figma preview import failed.";
    redirect(`${back}?error=${encodeURIComponent(message.slice(0, 300))}`);
  }

  await auditBulk(session, "sign.import_previews", summary);
  revalidatePath(back);
  revalidatePath("/signs");
  redirect(`${back}?ok=${encodeURIComponent(summary)}`);
}
