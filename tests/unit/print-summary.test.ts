import { describe, it, expect } from "vitest";

import {
  categoryFromSize,
  computePrintSummary,
  isMeterboard,
  sectionCategory,
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

describe("categoryFromSize", () => {
  it("maps sizes to item classes (printed paper + 8x20 win over 4x8)", () => {
    expect(categoryFromSize('22"x28"')).toBe("easel_sign");
    expect(categoryFromSize("24x36")).toBe("easel_sign");
    expect(categoryFromSize("4'x8' Double")).toBe("meterboard");
    expect(categoryFromSize("Socks")).toBe("socks");
    expect(categoryFromSize("8'x20'")).toBe("union_installed");
    // A paper "4'x8' (printed)" command map is an ops map, NOT a meterboard.
    expect(categoryFromSize("4' x 8' (printed)")).toBe("ops_map");
    expect(categoryFromSize("nonsense")).toBe("other");
  });
});

describe("sectionCategory", () => {
  it("maps sheet section headers to classes (null when not a class section)", () => {
    expect(sectionCategory("Command Maps (printed on paper, not meterboard)")).toBe("ops_map");
    expect(sectionCategory('22" x 28"')).toBe("easel_sign");
    expect(sectionCategory("21\" x 42\" Flying Signs (Socks)")).toBe("socks");
    expect(sectionCategory("8' x 4' Foamcore Banners")).toBe("union_installed");
    expect(sectionCategory("4' x 8' Meter Boards (Double Sided)")).toBe("meterboard");
    expect(sectionCategory("Villages / Communities")).toBeNull();
  });
});

// One group per (category, size, doubleSided, needsEasel, printable) — the inventory
// page's groupBy shape. Exercises the three rules: easels honor the flag, stands are
// category-based, prints exclude non-printable bare easels.
const groups: SizeGroup[] = [
  { category: "easel_sign", size: '22" x 28"', doubleSided: false, needsEasel: true, printable: true, quantity: 10 },
  { category: "easel_sign", size: '22" x 28"', doubleSided: true, needsEasel: false, printable: true, quantity: 4 },
  { category: "easel_sign", size: '24" x 36"', doubleSided: false, needsEasel: true, printable: true, quantity: 6 },
  { category: "meterboard", size: "4' x 8' Double", doubleSided: true, needsEasel: false, printable: true, quantity: 8 },
  { category: "union_installed", size: "8'x20'", doubleSided: false, needsEasel: false, printable: true, quantity: 2 },
  { category: "socks", size: "Socks", doubleSided: false, needsEasel: false, printable: true, quantity: 3 },
  { category: "ops_map", size: "4' x 8' (printed)", doubleSided: false, needsEasel: false, printable: true, quantity: 5 },
  // Bare easels: need an easel, print nothing.
  { category: "easel_sign", size: '22" x 28"', doubleSided: false, needsEasel: true, printable: false, quantity: 7 },
];

describe("computePrintSummary", () => {
  const summary = computePrintSummary(groups);

  it("totalSigns counts printable rows only (bare easels excluded)", () => {
    expect(summary.totalSigns).toBe(38); // 10+4+6+8+2+3+5, not the 7 bare easels
  });

  it("easelsRequired honors the Easel Y/N flag, incl. bare easels", () => {
    expect(summary.easelsRequired).toBe(23); // 10 + 6 + 7 bare
  });

  it("meterboard stands come from the meterboard category, not 4x8 sizes", () => {
    // Only the real meterboard (8) — the ops_map "4'x8' (printed)" does NOT add a stand.
    expect(summary.meterboardStands).toBe(8);
  });

  it("buckets by material; paper ops maps + banners get their own lines", () => {
    const byKey = Object.fromEntries(summary.materials.map((m) => [m.key, m]));
    expect(byKey["22x28"]).toMatchObject({ single: 10, double: 4, total: 14 });
    expect(byKey["24x36"]).toMatchObject({ total: 6 });
    expect(byKey["meterboard"]).toMatchObject({ single: 0, double: 8, total: 8 });
    expect(byKey["banner"]).toMatchObject({ total: 2 });
    expect(byKey["socks"]).toMatchObject({ total: 3 });
    expect(byKey["ops-map"]).toMatchObject({ total: 5 });
    // The paper map landed in ops-map, NOT meterboard.
    expect(byKey["meterboard"].total).toBe(8);
  });

  it("sorts materials by total descending", () => {
    const totals = summary.materials.map((m) => m.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(summary.materials[0].key).toBe("22x28");
  });
});
