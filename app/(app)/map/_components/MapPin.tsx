"use client";

import { KeepScale } from "react-zoom-pan-pinch";

// A real map-pin marker (teardrop) whose TIP marks the exact point — replacing the
// old flat centred dot. Two things make it precise when zoomed:
//   1. KeepScale (from react-zoom-pan-pinch) holds the marker at a constant
//      on-screen size at any zoom, so it never bloats into a blob as you zoom in.
//   2. The `.map-pin` class pins the counter-scale origin to the TIP
//      (transform-origin: bottom center). KeepScale only ever writes `transform`
//      (the scale) and never touches transform-origin, so the tip stays glued to
//      its coordinate while the body scales around it.
// The positioning wrapper (in FloorPinView / MapPinPicker) anchors the tip with
// `-translate-x-1/2 -translate-y-full`; this component never sets a transform of
// its own (KeepScale owns it). Colour comes from `currentColor` via `toneClass`
// (a Tailwind text-* class), so status tones and the accent default both work.
//
// MUST be rendered inside a ZoomCanvas (a react-zoom-pan-pinch TransformWrapper) —
// KeepScale reads the transform context.
export function MapPin({
  active = false,
  toneClass,
}: {
  active?: boolean;
  // A Tailwind TEXT colour class (e.g. "text-[var(--accent)]"); fills the marker
  // via currentColor. Defaults to the accent.
  toneClass?: string;
}) {
  const size = active ? 30 : 22; // on-screen px — KeepScale keeps this constant
  return (
    <KeepScale className={`map-pin block ${toneClass ?? "text-[var(--accent)]"}`}>
      {/* Teardrop with its point at the bottom-centre (12,24) of the viewBox, so
          the tip sits exactly at the marker box's bottom-centre (the KeepScale
          counter-scale origin). White stroke = halo against the floor image. */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        className="block"
      >
        <path
          d="M12 0 C18.627 0 24 5.149 24 11.5 C24 17.851 12 24 12 24 C12 24 0 17.851 0 11.5 C0 5.149 5.373 0 12 0 Z"
          fill="currentColor"
          stroke="#fff"
          strokeWidth="1.5"
        />
        <circle cx="12" cy="10.5" r="4" fill="#fff" />
      </svg>
    </KeepScale>
  );
}
