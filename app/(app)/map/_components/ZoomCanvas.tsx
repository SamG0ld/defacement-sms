"use client";

import type { ReactNode } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

const BTN =
  "rounded bg-black/60 px-2 py-0.5 text-sm text-zinc-100 ring-1 ring-white/20 hover:bg-black/80";

// Reusable zoom/pan frame for the floor maps. Wraps its children (a relative
// image + pin layer) so the whole thing scales/translates together — pins,
// positioned by percentage, stay locked to their spots at any zoom. Supports
// wheel, pinch, double-tap-to-zoom, drag-pan, and explicit +/−/reset controls.
export function ZoomCanvas({
  children,
  maxScale = 6,
  doubleClickZoom = true,
}: {
  children: ReactNode;
  maxScale?: number;
  doubleClickZoom?: boolean;
}) {
  return (
    <TransformWrapper
      minScale={1}
      maxScale={maxScale}
      wheel={{ step: 0.15 }}
      doubleClick={{ disabled: !doubleClickZoom, mode: "zoomIn" }}
    >
      {({ zoomIn, zoomOut, resetTransform }) => (
        <div className="relative overflow-hidden rounded-lg border border-zinc-800 bg-white">
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
