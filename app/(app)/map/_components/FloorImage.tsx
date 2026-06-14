"use client";

import { useState } from "react";

// The floor-map image with a skeleton shown until the bytes load. The image is
// served through the auth-gated /api/maps route, which can be slow on bad RF (the
// field scenario), so a placeholder beats a blank white box. A tiny client island
// (onLoad is a client event) used by the otherwise-server FloorPinView; the pins
// layer stays server. While loading we reserve an aspect-[4/3] box (matching the
// route-level loading.tsx) so the skeleton has somewhere to draw and the swap
// doesn't shift the whole page; on load we release to the image's natural height.
// The `.skeleton` shimmer is aria-hidden and frozen for reduced-motion by the
// global guard.
export function FloorImage({ src, label }: { src: string; label: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`relative w-full ${loaded ? "" : "aspect-[4/3]"}`}>
      {!loaded && (
        <div className="skeleton absolute inset-0 h-full w-full" aria-hidden />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- DB-served floorplan, intrinsic size unknown */}
      <img
        src={src}
        alt={label}
        onLoad={() => setLoaded(true)}
        draggable={false}
        className="block h-auto w-full select-none"
      />
    </div>
  );
}
