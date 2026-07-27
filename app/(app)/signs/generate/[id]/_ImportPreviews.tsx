"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  importBatchPreviewsSlice,
  type PreviewSliceResult,
} from "../../generate-actions";

// Client driver for importer A. Replaces the old opaque server-action <form> submit
// (which black-boxed a multi-minute import and 504'd the 242-sign batch) with a
// slice loop: it calls importBatchPreviewsSlice(batchId, offset) until `done`,
// showing an instant pending state on click and a live progress bar. A slice failure
// surfaces inline with a resume-from-offset retry instead of the generic error page.

type Phase = "idle" | "importing" | "done" | "error";

const BTN =
  "rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

export function ImportPreviews({
  batchId,
  hasFigmaUrl,
}: {
  batchId: number;
  hasFigmaUrl: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [imported, setImported] = useState(0);
  const [failed, setFailed] = useState(0);
  const [processed, setProcessed] = useState(0);
  // null until the first slice returns the denominator, so the bar starts indeterminate.
  const [total, setTotal] = useState<number | null>(null);
  const [unmatched, setUnmatched] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Where a failed run should resume from (kept so Retry doesn't redo committed work).
  const [resumeOffset, setResumeOffset] = useState(0);

  // Drive slices from `startOffset`, seeding the cumulative counters (a fresh run
  // seeds 0/0; a Retry seeds the counts already committed before the failure).
  async function run(startOffset: number, seedImported: number, seedFailed: number) {
    // Synchronous state flip BEFORE the first await → the button shows a pending
    // state the instant it's clicked (no more "…I guess it worked?").
    setPhase("importing");
    setError(null);

    let offset = startOffset;
    let impAcc = seedImported;
    let failAcc = seedFailed;

    while (true) {
      let result: PreviewSliceResult;
      try {
        result = await importBatchPreviewsSlice(batchId, offset);
      } catch {
        // Network/transport failure calling the action — resume this same slice.
        setError("Network error during import — retry to resume.");
        setResumeOffset(offset);
        setPhase("error");
        return;
      }

      if (!result.ok) {
        setError(result.error);
        setResumeOffset(result.nextOffset);
        setPhase("error");
        return;
      }

      impAcc += result.imported;
      failAcc += result.failed;
      offset = result.nextOffset;

      setImported(impAcc);
      setFailed(failAcc);
      setTotal(result.total);
      setProcessed(Math.min(offset, result.total));
      setUnmatched(result.unmatched);

      if (result.done) {
        setPhase("done");
        // Reflect the freshly-imported ✓ thumbnails in the server-rendered table.
        router.refresh();
        return;
      }
    }
  }

  const pct =
    total && total > 0 ? Math.round((processed / total) * 100) : phase === "done" ? 100 : 0;
  const indeterminate = phase === "importing" && total === null;

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN}
          disabled={!hasFigmaUrl || phase === "importing"}
          onClick={() =>
            phase === "error"
              ? run(resumeOffset, imported, failed)
              : run(0, 0, 0)
          }
        >
          {phase === "importing"
            ? "⤓ Importing…"
            : phase === "error"
              ? "↻ Retry import"
              : phase === "done"
                ? "⤓ Re-pull previews"
                : "⤓ Pull previews from Figma"}
        </button>
        <span className="text-xs text-zinc-500">
          {hasFigmaUrl
            ? "Imports each sign's rendered image by Item-ID match (nodes named “M-001 - …”)."
            : "Save the Figma file link first."}
        </span>
      </div>

      {(phase === "importing" || phase === "done") && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className={`h-full bg-accent transition-[width] duration-300 ${
                indeterminate ? "animate-pulse" : ""
              }`}
              style={{ width: indeterminate ? "100%" : `${pct}%` }}
            />
          </div>
          <p className="text-xs text-zinc-400" aria-live="polite">
            {phase === "done"
              ? `Done — imported ${imported} preview${imported === 1 ? "" : "s"}` +
                (unmatched > 0 ? `, ${unmatched} unmatched` : "") +
                (failed > 0 ? `, ${failed} failed` : "") +
                "."
              : total === null
                ? "Starting import…"
                : `Importing ${processed} / ${total}…` +
                  (failed > 0 ? ` (${failed} failed)` : "")}
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <p className="text-xs text-red-300" aria-live="polite">
          {imported > 0 ? `Imported ${imported} before stopping. ` : ""}
          {error}
        </p>
      )}
    </div>
  );
}
