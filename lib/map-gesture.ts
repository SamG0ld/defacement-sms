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
