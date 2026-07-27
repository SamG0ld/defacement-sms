import { describe, it, expect } from "vitest";

import { categoryFromSize } from "@/lib/print-summary";
import { EXTERNAL_CATEGORIES } from "@/app/(app)/signs/_lib";
import {
  SPECIALTY_TYPES,
  specialtyType,
} from "@/app/(app)/signs/specialty/_taxonomy";

describe("SPECIALTY_TYPES", () => {
  it("has a unique key per entry", () => {
    const keys = SPECIALTY_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a unique tagSlug per entry", () => {
    const slugs = SPECIALTY_TYPES.map((t) => t.tagSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("only uses categories that are external categories", () => {
    for (const t of SPECIALTY_TYPES) {
      expect(EXTERNAL_CATEGORIES).toContain(t.category);
    }
  });

  it("agrees with categoryFromSize for every non-null defaultSize", () => {
    // Load-bearing: the app derives category from size elsewhere (categoryFromSize).
    // A taxonomy default that disagrees would misclassify signs created from it.
    for (const t of SPECIALTY_TYPES) {
      if (t.defaultSize === null) continue;
      expect(categoryFromSize(t.defaultSize)).toBe(t.category);
    }
  });

  it("contains the expected entries", () => {
    const keys = SPECIALTY_TYPES.map((t) => t.key).sort();
    expect(keys).toEqual(
      [
        "banner",
        "floor-graphic",
        "floor-vinyl",
        "selfie-banner",
        "sticker-wall",
        "venue-map",
        "wall-graphic",
      ].sort(),
    );
  });
});

describe("specialtyType", () => {
  it("looks up a known key", () => {
    expect(specialtyType("banner")).toMatchObject({
      key: "banner",
      label: "Banner (large-format)",
      category: "union_installed",
      tagSlug: "banner",
      tagName: "Banner",
      defaultSize: "8'x20'",
    });
  });

  it("returns null for an unknown key", () => {
    expect(specialtyType("not-a-real-key")).toBeNull();
  });
});
