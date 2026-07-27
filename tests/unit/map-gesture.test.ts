import { describe, it, expect } from "vitest";

import { clampPct, deriveMaxScale, isTap } from "@/lib/map-gesture";

describe("isTap (tap vs pan on a zoomable map)", () => {
  it("treats a stationary / tiny-travel pointer as a tap", () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(true); // ~3.6px
  });

  it("treats travel beyond the threshold as a pan (not a tap)", () => {
    expect(isTap({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(false);
    expect(isTap({ x: 0, y: 0 }, { x: 5, y: 5 }, 6)).toBe(false); // ~7.07 > 6
  });

  it("respects a custom threshold", () => {
    expect(isTap({ x: 0, y: 0 }, { x: 5, y: 5 }, 8)).toBe(true); // ~7.07 ≤ 8
    expect(isTap({ x: 0, y: 0 }, { x: 5, y: 5 }, 6)).toBe(false); // ~7.07 > 6
  });

  it("is inclusive at exactly the threshold", () => {
    expect(isTap({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true); // == threshold
    expect(isTap({ x: 0, y: 0 }, { x: 7, y: 0 })).toBe(false); // just over
  });
});

describe("clampPct", () => {
  it("clamps to 0–100 and rounds to 2dp", () => {
    expect(clampPct(-3)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(42.6789)).toBe(42.68);
  });
});

describe("deriveMaxScale (zoom ceiling = native width / measured container width)", () => {
  it("reaches native pixels on a wide desktop pane", () => {
    // A ~850px pane showing a 5250px DC34 floor: ceil(6.18) = 7.
    expect(deriveMaxScale(5250, 850)).toBe(7);
  });

  it("reaches native pixels on a narrow phone pane (where it matters most)", () => {
    // ~360px phone showing the same 5250px floor: ceil(14.58) = 15 — the fixed-
    // 700 guess would have stopped at 8 and left half the detail unreachable.
    expect(deriveMaxScale(5250, 360)).toBe(15);
  });

  it("never drops below the historical default of 6", () => {
    expect(deriveMaxScale(700, 700)).toBe(6); // ratio 1 → floored at 6
    expect(deriveMaxScale(2000, 850)).toBe(6); // ceil(2.35)=3 → floored at 6
  });

  it("caps the ceiling as a backstop against corrupt width metadata", () => {
    expect(deriveMaxScale(1_000_000, 700)).toBe(24);
  });

  it("falls back to the default when width is unknown or invalid", () => {
    expect(deriveMaxScale(null)).toBe(6);
    expect(deriveMaxScale(undefined)).toBe(6);
    expect(deriveMaxScale(0)).toBe(6);
    expect(deriveMaxScale(-500)).toBe(6);
    expect(deriveMaxScale(5250, 0)).toBe(6); // guard: not-yet-measured container
  });
});
