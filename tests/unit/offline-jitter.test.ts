import { describe, it, expect } from "vitest";

import { jitterMs } from "@/lib/offline/jitter";

describe("jitterMs", () => {
  it("returns 0 at the low end of the random range", () => {
    expect(jitterMs(5000, () => 0)).toBe(0);
  });

  it("scales linearly with the random value", () => {
    expect(jitterMs(5000, () => 0.5)).toBe(2500);
  });

  it("stays strictly below maxMs at the high end", () => {
    expect(jitterMs(5000, () => 0.9999)).toBe(4999);
    expect(jitterMs(5000, () => 0.9999)).toBeLessThan(5000);
  });

  it("respects a custom maxMs", () => {
    const v = jitterMs(20_000, () => 0.25);
    expect(v).toBe(5000);
  });

  it("defaults to a 0–5000ms window with real Math.random", () => {
    for (let i = 0; i < 50; i++) {
      const v = jitterMs();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5000);
    }
  });
});
