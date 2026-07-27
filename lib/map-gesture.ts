export type Point = { x: number; y: number };

// Distinguish a tap (place a pin) from a pan (drag the map) on a zoomable
// surface: a pointerdown→pointerup whose travel stays under the threshold is a
// tap. Pure so the placement component can be reasoned about + unit-tested.
export function isTap(start: Point, end: Point, threshold = 6): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= threshold;
}

// Clamp a raw percentage to the 0–100 floor-image range, rounded to 2dp.
export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Number(value.toFixed(2))));
}

// How far the zoom UI should let you scale in. ZoomCanvas fits the image to its
// container, so to reach the image's native pixels you need scale ≈
// nativeWidth / renderedWidth. `renderedWidth` is the MEASURED container width
// (ZoomCanvas passes it via ResizeObserver) — the same map renders in a wide
// desktop pane and a ~360px phone, so a fixed guess would under-reach native on
// the phone (exactly where "zoom all the way in" matters most). Floored at the
// historical default (6) so nothing zooms less than before, and capped (24) as a
// sanity backstop against corrupt width metadata. Width unknown (legacy/missing
// metadata) or a not-yet-measured container → keep the default.
export function deriveMaxScale(
  width: number | null | undefined,
  renderedWidth = 700,
): number {
  if (!width || width <= 0 || renderedWidth <= 0) return 6;
  return Math.min(24, Math.max(6, Math.ceil(width / renderedWidth)));
}
