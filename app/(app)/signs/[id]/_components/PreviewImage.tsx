"use client";

import { useEffect, useState } from "react";

// Sign-art preview: a thumbnail that opens a full-size lightbox on click. The
// image is served from our auth-gated route (plain <img>, not next/image — CSP
// img-src 'self' already allows it). `cacheBust` lets the parent force a reload
// after a replace/upload without a full navigation.
export function PreviewImage({
  signId,
  alt,
  cacheBust,
}: {
  signId: number;
  alt: string;
  cacheBust?: string | number;
}) {
  const [open, setOpen] = useState(false);

  const src = `/api/signs/${signId}/preview${
    cacheBust != null ? `?v=${encodeURIComponent(String(cacheBust))}` : ""
  }`;

  // Close the lightbox on Escape; only bind the listener while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block overflow-hidden rounded border border-zinc-800 bg-zinc-900 transition hover:border-zinc-600"
        aria-label="Enlarge art preview"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="max-h-48 w-auto object-contain"
        />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </>
  );
}
