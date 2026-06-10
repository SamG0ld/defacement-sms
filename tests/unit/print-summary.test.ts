import { describe, it, expect } from "vitest";

import {
  computePrintSummary,
  isMeterboard,
  signTypeFromSize,
  type SizeGroup,
} from "@/lib/print-summary";

describe("isMeterboard", () => {
  it("matches meterboard / 4x8 sizes", () => {
    expect(isMeterboard("4' x 8' Meter Board")).toBe(true);
    expect(isMeterboard("Meterboard (4x8)")).toBe(true);
    expect(isMeterboard("4x8")).toBe(true);
  });

  it("does not match other sizes (incl. a 4x8 banner — banner wins)", () => {
    expect(isMeterboard('22" x 28"')).toBe(false);
    expect(isMeterboard("4x8 banner")).toBe(false);
  });
});

describe("signTypeFromSize", () => {
  it("maps the real size strings to the canonical form vocabulary", () => {
    expect(signTypeFromSize('22"x28"')).toBe('22"x28"');
    expect(signTypeFromSize('22" x 28"')).toBe('22"x28"'); // spacing variant
    expect(signTypeFromSize("24x36")).toBe('24"x36"');
    expect(signTypeFromSize("4'x8' Double")).toBe("Meterboard (4'x8')");
    expect(signTypeFromSize("Socks")).toBe("Socks");
    expect(signTypeFromSize("8'x20'")).toBe("8'x20'");
    expect(signTypeFromSize("4x8 banner")).toBe("Banner");
  });

  it("falls back to the generic 'Sign' for sizes with no known form", () => {
    expect(signTypeFromSize("36x48")).toBe("Sign");
    expect(signTypeFromSize("12x18")).toBe("Sign");
  });
});

const groups: SizeGroup[] = [
  { size: '22" x 28"', doubleSided: false, quantity: 10 },
  { size: '22" x 28"', doubleSided: true, quantity: 4 },
  { size: '24" x 36"', doubleSided: false, quantity: 6 },
  { size: "4' x 8' Meter Board", doubleSided: true, quantity: 8 },
  { size: "8'x20' Banner", doubleSided: false, quantity: 2 },
  { size: "21x42 socks", doubleSided: false, quantity: 3 },
];

describe("computePrintSummary", () => {
  const summary = computePrintSummary(groups);

  it("sums totals and derives easels from 22x28 + 24x36 counts", () => {
    expect(summary.totalSigns).toBe(33);
    // 22x28 total 14 + 24x36 total 6 = 20 easels needed.
    expect(summary.easelsRequired).toBe(20);
  });

  it("counts meterboard stands from meterboard signs", () => {
    expect(summary.meterboardStands).toBe(8);
  });

  it("buckets by material with single/double split", () => {
    const byKey = Object.fromEntries(summary.materials.map((m) => [m.key, m]));
    expect(byKey["22x28"]).toMatchObject({ single: 10, double: 4, total: 14 });
    expect(byKey["24x36"]).toMatchObject({ total: 6 });
    expect(byKey["meterboard"]).toMatchObject({ single: 0, double: 8, total: 8 });
    expect(byKey["banner"]).toMatchObject({ total: 2 });
    expect(byKey["socks"]).toMatchObject({ total: 3 });
  });

  it("classifies a banner before meterboard (order is load-bearing)", () => {
    // "8'x20' Banner" must not fall into the meterboard 4x8 bucket.
    const byKey = Object.fromEntries(summary.materials.map((m) => [m.key, m]));
    expect(byKey["banner"]).toBeDefined();
  });

  it("sorts materials by total descending", () => {
    const totals = summary.materials.map((m) => m.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(summary.materials[0].key).toBe("22x28");
  });
});
