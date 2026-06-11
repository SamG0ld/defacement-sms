// Pure geometry for client-side image downscaling. The sign-preview upload draws
// the chosen file onto a canvas sized by this helper before encoding, so the bytes
// that leave the browser are already a web-resolution preview (not the full-res
// print export). No DOM/Canvas here — just the math, so it's unit-testable.

export type Dimensions = { width: number; height: number };

// Clamp (width, height) so the longest edge is at most `max`, preserving aspect
// ratio. Never upscales: an image already within the bound is returned unchanged.
// Non-positive inputs collapse to 0×0 (caller treats that as "nothing to draw").
export function fitDimensions(
  width: number,
  height: number,
  max: number,
): Dimensions {
  if (width <= 0 || height <= 0 || max <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(width, height);
  if (longest <= max) {
    return { width, height };
  }
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
