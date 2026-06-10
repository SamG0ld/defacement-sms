import { describe, it, expect } from "vitest";

import { clampPct, isTap } from "@/lib/map-gesture";

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
