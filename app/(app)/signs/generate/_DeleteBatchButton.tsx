"use client";

// Per-row delete on the /signs/generate index. Two-stage click-then-confirm (the
// arm→confirm shape from _status-control.tsx, without the status-queue machinery —
// this is a plain Server-Action form): the resting "Delete" swaps to an inline
// "Delete N-sign batch? · Confirm / Cancel". Deleting a batch is non-destructive to
// the signs — Sign.generationBatchId is onDelete: SetNull, so they're preserved and
// only lose the batch grouping. lead+ is enforced server-side in deleteGenerationBatch.

import { useState } from "react";

import { deleteGenerationBatch } from "../generate-actions";

export function DeleteBatchButton({
  batchId,
  signCount,
}: {
  batchId: number;
  signCount: number;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-500 hover:border-red-900 hover:text-red-300"
      >
        Delete
      </button>
    );
  }

  return (
    <form
      action={deleteGenerationBatch.bind(null, batchId)}
      className="flex flex-wrap items-center gap-2"
    >
      <span
        className="text-xs text-zinc-400"
        title="Removes the batch grouping only; the signs are preserved."
      >
        Delete {signCount}-sign batch? (signs kept)
      </span>
      <button
        type="submit"
        className="rounded border border-red-900 bg-red-950/40 px-2 py-0.5 text-xs uppercase text-red-300 hover:bg-red-950/70"
      >
        ✓ Confirm
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded border border-zinc-800 px-2 py-0.5 text-xs uppercase text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
      >
        Cancel
      </button>
    </form>
  );
}
