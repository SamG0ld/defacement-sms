"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { signDeployPhotoSrc } from "@/lib/deploy/photo";

import { DeployImg } from "../../_components/DeployImg";
import { MapPin } from "../../map/_components/MapPin";

// Full-screen lightbox for a sign's deploy photo, served through the auth-gated
// route (never the raw Blob URL). Closes on backdrop click, Esc, or the button.
// Portaled to <body> so it escapes any transformed ancestor — the map pin lives
// inside ZoomCanvas (a CSS transform), which would otherwise break `fixed`.
function PhotoLightbox({
  signId,
  onClose,
}: {
  signId: number;
  onClose: () => void;
}) {
  useEffect(() => {
    // Lock body scroll while open — the overlay shouldn't let the page behind it
    // scroll on a phone (the floor device).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deploy photo"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        autoFocus
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close photo"
        className="absolute right-4 top-4 rounded-full bg-zinc-900/80 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        Close ✕
      </button>
      <DeployImg
        src={signDeployPhotoSrc(signId)}
        alt="Deployed sign"
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded object-contain shadow-2xl"
        fallbackClassName="rounded bg-zinc-900 px-6 py-4 text-sm text-zinc-400"
      />
    </div>,
    document.body,
  );
}

// Thumbnail for the sign-detail "Delivery & deployment" panel. Tap to enlarge.
export function DeployPhotoThumb({ signId }: { signId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="View deploy photo"
        className="block overflow-hidden rounded border border-zinc-700 hover:border-accent focus:border-accent focus:outline-none"
      >
        {/* alt="" — the wrapping button's aria-label is the actionable label, so
            the thumbnail is presentational and shouldn't be double-announced. */}
        <DeployImg
          src={signDeployPhotoSrc(signId)}
          alt=""
          loading="lazy"
          className="h-28 w-auto select-none object-cover"
          fallbackClassName="flex h-28 items-center justify-center bg-zinc-900 px-3 text-xs text-zinc-500"
        />
      </button>
      {open && <PhotoLightbox signId={signId} onClose={() => setOpen(false)} />}
    </>
  );
}

// Map-pin variant: a teardrop MapPin rendered as a button that opens the same
// lightbox. Visual parity with the other markers in FloorPinView; always rendered
// inside ZoomCanvas, which MapPin's KeepScale requires.
export function DeployPhotoPin({
  signId,
  active,
  title,
}: {
  signId: number;
  active?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title ? `${title} — view photo` : "View deploy photo"}
        className="block p-0"
      >
        <MapPin active={active} />
      </button>
      {open && <PhotoLightbox signId={signId} onClose={() => setOpen(false)} />}
    </>
  );
}
