"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";
import { MAX_IMAGE_BYTES } from "@/lib/image-upload";

// Deploy confirmation sheet: optional notes + optional photo. The photo is never
// required (locked decision — a missing photo must never block a deploy on the
// floor). `capture="environment"` opens the rear camera on mobile; on desktop it
// falls back to a file picker.
//
// Modal semantics follow the house pattern (AppShell's More sheet, the deploy
// photo lightbox): role="dialog" + aria-modal on the panel, focus moved in on
// open, Escape closes, focus restored to whatever opened it. Before #188 this was
// a bare fixed div — assistive tech never announced a dialog had opened, Escape
// did nothing, and focus stayed wherever it happened to be, so a keyboard user
// had to tab through the whole page behind the sheet to reach its fields.
export function DeploySheet({
  sign,
  onConfirm,
  onCancel,
}: {
  sign: DeploySignView;
  onConfirm: (opts: { notes?: string; photo?: Blob }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // `onCancel` is an inline arrow from DeployApp, so its identity changes on every
  // store tick (a sync runs every 20s). Reading it through a ref keeps the effect
  // below mount-only — depending on the prop directly would re-run it on each
  // tick, yanking focus out of the notes field while a volunteer is typing.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    // Remember who opened us so focus can go back there on close — otherwise it
    // lands on <body> and a keyboard user restarts from the top of the page.
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  // Reject an oversized photo HERE rather than letting it into the outbox: the
  // queue is FIFO, so a 20MB camera original sits at the head of it failing to
  // upload over a dead show-floor link and blocks every claim and deploy queued
  // behind it. Same ceiling the upload route enforces (lib/image-upload.ts), read
  // from the one constant so the two can't drift. (#193)
  const onPickPhoto = (file: File | null) => {
    if (file && file.size > MAX_IMAGE_BYTES) {
      setPhoto(null);
      setPhotoError(
        `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ` +
          `${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB. Retake it at a lower ` +
          `resolution, or deploy without a photo.`,
      );
      return;
    }
    setPhotoError(null);
    setPhoto(file);
  };

  // Outbox idempotency is keyed by a freshly-generated clientId per enqueue, NOT
  // by the sign — so a double-tap while the IndexedDB write is in flight queues
  // TWO deploy events and TWO photo uploads for the same sign. Very plausible on
  // a touchscreen in the field. Guard the button for the duration of the await.
  // (#179)
  const [submitting, setSubmitting] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-md space-y-4 rounded-t-2xl border border-[var(--line)] bg-[var(--surface)] p-4 focus:outline-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-accent">
            Deploy sign
          </h2>
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
            className="field w-full"
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
            onChange={(e) => {
              onPickPhoto(e.target.files?.[0] ?? null);
              // Clear the input so re-picking the SAME file after a rejection
              // still fires change (the browser suppresses it otherwise).
              e.target.value = "";
            }}
            className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200"
          />
          {photo && (
            <span className="text-xs text-zinc-500">
              {photo.name} ({Math.round(photo.size / 1024)} KB)
            </span>
          )}
          {photoError && (
            <span role="alert" className="block text-xs text-danger">
              {photoError}
            </span>
          )}
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="btn flex-1 justify-center"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              try {
                await onConfirm({
                  notes: notes.trim() || undefined,
                  photo: photo ?? undefined,
                });
              } finally {
                // The sheet stays mounted when the deploy fails (so the captured
                // photo isn't lost), so the button must become usable again.
                setSubmitting(false);
              }
            }}
            className="btn btn-primary flex-1 justify-center"
          >
            {submitting ? "Saving…" : "Mark deployed"}
          </button>
        </div>
      </div>
    </div>
  );
}
