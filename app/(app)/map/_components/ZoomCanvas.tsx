"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

import { deriveMaxScale } from "@/lib/map-gesture";

// Shared console button so the controls inherit the Phase-4 press + focus-visible
// feedback. Rendered over the (white) floor image; the dark .btn surface reads fine.
const BTN = "btn btn-sm";

// Reusable zoom/pan frame for the floor maps. Wraps its children (a relative
// image + pin layer) so the whole thing scales/translates together — pins,
// positioned by percentage, stay locked to their spots at any zoom. Supports
// wheel, pinch, double-tap-to-zoom, drag-pan, and explicit +/−/reset controls.
//
// Zoom ceiling: when the caller passes the image's native `imageWidth`, we derive
// how far to allow zooming from the ACTUAL rendered container width (measured via
// ResizeObserver) so a high-res map reaches its native pixels on both a wide
// desktop pane and a narrow phone. Without imageWidth (legacy callers), it holds
// the historical default of 6.
export function ZoomCanvas({
  children,
  imageWidth,
  doubleClickZoom = true,
}: {
  children: ReactNode;
  imageWidth?: number | null;
  doubleClickZoom?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [maxScale, setMaxScale] = useState(6);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || !imageWidth) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setMaxScale(deriveMaxScale(imageWidth, w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageWidth]);

  return (
    <TransformWrapper
      minScale={1}
      maxScale={maxScale}
      wheel={{ step: 0.15 }}
      doubleClick={{ disabled: !doubleClickZoom, mode: "zoomIn" }}
    >
      {({ zoomIn, zoomOut, resetTransform }) => (
        <div
          ref={frameRef}
          className="relative overflow-hidden rounded-lg border border-zinc-800 bg-white"
        >
          <div className="absolute right-2 top-2 z-10 flex gap-1">
            <button type="button" aria-label="Zoom in" className={BTN} onClick={() => zoomIn()}>
              +
            </button>
            <button type="button" aria-label="Zoom out" className={BTN} onClick={() => zoomOut()}>
              −
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              className={BTN}
              onClick={() => resetTransform()}
            >
              reset
            </button>
          </div>
          <TransformComponent wrapperClass="!w-full" contentClass="!w-full">
            {children}
          </TransformComponent>
        </div>
      )}
    </TransformWrapper>
  );
}
