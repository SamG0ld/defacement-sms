"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { fitDimensions } from "@/lib/preview-image";

// Max long edge for the stored preview. The detail image is a web preview, not the
// print export — ~1600px is sharp at the lightbox size while keeping uploads small.
const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.85;

// Downscale a chosen image file to a web-resolution WebP, client-side via Canvas,
// then POST the bytes to the preview route. Keeps uploads to ~200-400 KB and means
// no server image dependency (no sharp). lead+ only — rendered behind a role gate.
export function PreviewUpload({
  signId,
  hasPreview,
}: {
  signId: number;
  hasPreview: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downscale(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = fitDimensions(
        bitmap.width,
        bitmap.height,
        MAX_EDGE,
      );
      if (width === 0 || height === 0) {
        throw new Error("Image has no dimensions.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas not supported.");
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", WEBP_QUALITY),
      );
      if (!blob) throw new Error("Could not encode image.");
      return blob;
    } finally {
      bitmap.close();
    }
  }

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const blob = await downscale(file);
      const res = await fetch(`/api/signs/${signId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "image/webp" },
        body: blob,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Upload failed (${res.status}).`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/signs/${signId}/preview`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Remove failed (${res.status}).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Working…" : hasPreview ? "Replace preview" : "Upload preview"}
        </button>
        {hasPreview && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950 disabled:opacity-50"
          >
            Remove
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
