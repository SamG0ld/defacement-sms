"use client";

import { useState } from "react";

// Deploy photos stream through an auth-gated route; on the floor (flaky signal,
// stale blob) that load can fail. Render a labeled placeholder instead of the
// browser's broken-image glyph so the failure is visible at a glance.
//
// onClick is applied on both branches so caller intent (e.g. the lightbox's
// stopPropagation) survives a failed load. alt="" keeps its <img> meaning:
// presentational — the fallback is then aria-hidden so a labeled parent control
// (like the thumbnail button) isn't double-announced.
export function DeployImg({
  fallbackClassName,
  alt,
  onClick,
  ...imgProps
}: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "onClick"> & {
  fallbackClassName: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className={fallbackClassName}
        onClick={onClick}
        {...(alt === ""
          ? { "aria-hidden": true }
          : { role: "img", "aria-label": "Photo unavailable" })}
      >
        Photo unavailable
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- auth-gated streamed blob, intrinsic size unknown
    <img alt={alt} onClick={onClick} onError={() => setFailed(true)} {...imgProps} />
  );
}
