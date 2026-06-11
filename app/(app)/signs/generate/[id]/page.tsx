import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";

import { formatDateTime, statusBadgeClass } from "../../_lib";
import {
  importBatchPreviews,
  updateBatchFigmaUrl,
} from "../../generate-actions";

// importBatchPreviews (a Server Action POSTed to this route segment) does one
// Figma image download per sign — a 150+ sign batch can run well past the default
// Vercel function limit, leaving a partial import. Lift the cap for this segment.
export const maxDuration = 300;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
};

// Batch detail (lead+): the generation lifecycle for one batch — download the
// render-ready handoff CSV (the Figma render input), capture the Figma
// file URL after the render, and see which signs the batch covers.
export default async function BatchDetailPage({ params, searchParams }: Props) {
  await requireRole("lead");

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const { error, ok } = await searchParams;

  const batch = await prisma.generationBatch.findUnique({
    where: { id },
    select: {
      id: true,
      label: true,
      pipeline: true,
      figmaUrl: true,
      signCount: true,
      createdByEmail: true,
      createdById: true,
      createdAt: true,
      signs: {
        orderBy: [{ deploymentPriority: "asc" }, { itemId: "asc" }],
        select: {
          id: true,
          itemId: true,
          signText: true,
          size: true,
          status: true,
          previewImagePath: true,
          zone: { select: { zoneCode: true } },
        },
      },
    },
  });
  if (!batch) notFound();

  const FIELD =
    "rounded border border-zinc-700 bg-black px-2 py-1 text-sm text-zinc-100";
  const BTN =
    "rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">
            {batch.label ?? `Batch #${batch.id}`}
          </h1>
          <p className="text-sm text-zinc-400">
            {batch.signs.length} sign{batch.signs.length === 1 ? "" : "s"}
            {batch.signs.length !== batch.signCount
              ? ` (of ${batch.signCount} at generation)`
              : ""}{" "}
            · {batch.pipeline} · {formatDateTime(batch.createdAt)} ·{" "}
            {batch.createdByEmail ?? batch.createdById}
          </p>
        </div>
        <Link
          href="/signs/generate"
          className="shrink-0 text-sm text-accent hover:opacity-80"
        >
          ← All batches
        </Link>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error.slice(0, 300)}
        </p>
      )}
      {ok && (
        <p className="rounded border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          {ok.slice(0, 300)}
        </p>
      )}

      {/* Handoff + Figma link */}
      <div className="space-y-3 rounded border border-zinc-800 p-4">
        <a
          href={`/signs/generate/${batch.id}/export`}
          className={`inline-block ${BTN}`}
        >
          ⬇ Download handoff CSV
        </a>
        <p className="text-xs text-zinc-500">
          The render-ready list for this batch — the input the Figma render step
          consumes.
        </p>

        <form
          action={updateBatchFigmaUrl.bind(null, batch.id)}
          className="flex flex-wrap items-center gap-2 pt-2"
        >
          <input
            type="url"
            name="figmaUrl"
            defaultValue={batch.figmaUrl ?? ""}
            placeholder="https://www.figma.com/design/…"
            className={`min-w-[280px] flex-1 ${FIELD}`}
          />
          <button type="submit" className={BTN}>
            Save Figma link
          </button>
          {batch.figmaUrl && (
            <a
              href={batch.figmaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:opacity-80"
            >
              Open in Figma ↗
            </a>
          )}
        </form>

        {/* Importer A: pull the rendered images from Figma onto the signs. Matches
            nodes to signs by Item-ID name prefix; needs the Figma link saved. */}
        <form
          action={importBatchPreviews.bind(null, batch.id)}
          className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3"
        >
          <button type="submit" className={BTN} disabled={!batch.figmaUrl}>
            ⤓ Pull previews from Figma
          </button>
          <span className="text-xs text-zinc-500">
            {batch.figmaUrl
              ? "Imports each sign's rendered image by Item-ID match (nodes named “M-001 - …”)."
              : "Save the Figma file link first."}
          </span>
        </form>
      </div>

      {/* Signs in the batch */}
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Sign Text</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Preview</th>
            </tr>
          </thead>
          <tbody>
            {batch.signs.map((s) => (
              <tr
                key={s.id}
                className="border-b border-zinc-900 hover:bg-zinc-900/50"
              >
                <td className="px-3 py-2 text-zinc-400">{s.itemId}</td>
                <td className="px-3 py-2">
                  <Link
                    href={`/signs/${s.id}`}
                    className="text-accent hover:opacity-80"
                  >
                    {s.signText}
                  </Link>
                </td>
                <td className="px-3 py-2 text-zinc-400">{s.size}</td>
                <td className="px-3 py-2 text-zinc-400">
                  {s.zone?.zoneCode ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s.status)}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {s.previewImagePath ? (
                    <span className="text-accent" title="Preview imported">
                      ✓
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            ))}
            {batch.signs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-sm text-zinc-500">
                  No signs are linked to this batch (they may have been deleted or
                  re-generated into a newer batch).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
