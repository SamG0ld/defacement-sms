"use client";

import { useState } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";

// Deploy confirmation sheet: optional notes + optional photo. The photo is never
// required (locked decision — a missing photo must never block a deploy on the
// floor). `capture="environment"` opens the rear camera on mobile; on desktop it
// falls back to a file picker.
export function DeploySheet({
  sign,
  onConfirm,
  onCancel,
}: {
  sign: DeploySignView;
  onConfirm: (opts: { notes?: string; photo?: Blob }) => void;
  onCancel: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-t-2xl border border-zinc-800 bg-zinc-950 p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold text-accent">Deploy sign</h2>
          <p className="text-sm text-zinc-400">
            {sign.itemId}
            {sign.signText ? ` — ${sign.signText}` : ""}
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Notes (optional)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="e.g. mounted by north entrance"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Photo (optional)
          </span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200"
          />
          {photo && (
            <span className="text-xs text-zinc-500">
              {photo.name} ({Math.round(photo.size / 1024)} KB)
            </span>
          )}
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm({
                notes: notes.trim() || undefined,
                photo: photo ?? undefined,
              })
            }
            className="btn-primary flex-1 rounded px-3 py-2 text-sm font-medium"
          >
            Mark deployed
          </button>
        </div>
      </div>
    </div>
  );
}
