"use client";

import { useRef, useState } from "react";

import { clampPct, isTap } from "@/lib/map-gesture";

import { MapPin } from "./MapPin";
import { ZoomCanvas } from "./ZoomCanvas";

// Click-to-place primitive over a zoomable floor map. Zoom in (wheel / pinch /
// buttons) to place precisely; a drag pans the map, a tap drops/moves the pin.
// Tap-vs-pan is decided by pointer travel (lib/map-gesture isTap). Coordinates
// are percentages of the image, resolution-independent and correct under zoom
// because they're read from the (transformed) <img> rect. `hiddenFields` carries
// the bound action's discriminators (mode, floor, …). Reused by sign placement
// and room-registry placement.
export function MapPinPicker({
  src,
  label,
  initial,
  action,
  hiddenFields = {},
  saveLabel = "Save pin",
  currentMarker = null,
}: {
  src: string;
  label: string;
  initial: { x: number; y: number } | null;
  action: (formData: FormData) => void | Promise<void>;
  hiddenFields?: Record<string, string>;
  saveLabel?: string;
  // A read-only "where it is now" marker shown distinctly from the editable pin
  // (e.g. for a room-placed sign whose pin isn't an editable override). Lets one
  // map show current placement AND act as the editor without a second map.
  currentMarker?: { x: number; y: number } | null;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(initial);
  const imgRef = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return; // primary button / touch only
    down.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const start = down.current;
    down.current = null;
    if (!start) return;
    // A drag = pan; only a tap places a pin.
    if (!isTap(start, { x: e.clientX, y: e.clientY })) return;
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return; // tapped outside the image
    setPos({ x: clampPct(x), y: clampPct(y) });
  }

  return (
    <div className="space-y-3">
      <ZoomCanvas doubleClickZoom={false}>
        <div
          className="relative w-full cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- static bundled floorplan */}
          <img
            ref={imgRef}
            src={src}
            alt={label}
            className="block h-auto w-full select-none"
            draggable={false}
          />
          {/* Current location (read-only) — shown when no editable pin is set yet
              so the existing placement stays visible while you decide to move it. */}
          {currentMarker && !pos && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full"
              style={{ left: `${currentMarker.x}%`, top: `${currentMarker.y}%` }}
              title="Current location"
            >
              <MapPin active toneClass="text-zinc-400" />
            </div>
          )}
          {pos && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full"
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            >
              <MapPin active toneClass="text-[var(--accent)]" />
            </div>
          )}
        </div>
      </ZoomCanvas>

      <form action={action} className="flex items-center gap-3">
        {Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="x" value={pos?.x ?? ""} />
        <input type="hidden" name="y" value={pos?.y ?? ""} />
        <button
          type="submit"
          disabled={!pos}
          className="btn-primary rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveLabel}
        </button>
        <span className="text-xs text-zinc-500">
          {pos
            ? `${pos.x}%, ${pos.y}% — tap to reposition`
            : currentMarker
              ? "Shown at its current spot — tap the map to move it"
              : "Zoom in, then tap the map to drop a pin"}
        </span>
      </form>
    </div>
  );
}
