import { describe, it, expect } from "vitest";

import { fitDimensions } from "@/lib/preview-image";

describe("fitDimensions", () => {
  it("leaves an image already within the bound unchanged (no upscale)", () => {
    expect(fitDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("leaves an image exactly at the bound unchanged", () => {
    expect(fitDimensions(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it("clamps a landscape image to the max long edge, preserving aspect", () => {
    // 3200×1800, max 1600 → scale 0.5
    expect(fitDimensions(3200, 1800, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it("clamps a portrait image by its (taller) height", () => {
    // 1800×3200, max 1600 → scale 0.5
    expect(fitDimensions(1800, 3200, 1600)).toEqual({ width: 900, height: 1600 });
  });

  it("clamps a square image", () => {
    expect(fitDimensions(2400, 2400, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("rounds fractional scaled dimensions", () => {
    // 1000×333, max 500 → scale 0.5 → 500×166.5 → 167
    expect(fitDimensions(1000, 333, 500)).toEqual({ width: 500, height: 167 });
  });

  it("never collapses a tiny edge below 1px", () => {
    // 2000×2, max 1000 → scale 0.5 → height 1 (rounds to 1, not 0)
    expect(fitDimensions(2000, 2, 1000)).toEqual({ width: 1000, height: 1 });
  });

  it("returns 0×0 for non-positive inputs", () => {
    expect(fitDimensions(0, 600, 1600)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(800, 0, 1600)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(-10, 600, 1600)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(800, 600, 0)).toEqual({ width: 0, height: 0 });
  });
});
