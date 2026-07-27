import { describe, it, expect } from "vitest";

import {
  CUSTOM_BUCKET_KEY,
  SIGN_FORMATS,
  formatBucketForSize,
  formatBucketOrder,
  formatForKey,
  formatForSize,
  formatLabelForSign,
  formatTupleDiffers,
} from "@/lib/sign-format";
import { categoryFromSize, signTypeFromSize } from "@/lib/print-summary";

describe("SIGN_FORMATS table", () => {
  it("has unique keys and unique canonical sizes", () => {
    const keys = SIGN_FORMATS.map((f) => f.key);
    const sizes = SIGN_FORMATS.map((f) => f.size);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("keeps 4'x8' Single and Double as distinct formats differing only by double-sided", () => {
    const single = formatForKey("meterboard-single")!;
    const double = formatForKey("meterboard-double")!;
    expect(single.doubleSided).toBe(false);
    expect(double.doubleSided).toBe(true);
    expect(single.size).not.toBe(double.size); // distinct sizes, not one + a checkbox
    expect(single.signType).toBe(double.signType); // same physical canvas/type
  });

  it("labels the foamcore easel formats (not 'poster')", () => {
    const labels = SIGN_FORMATS.filter((f) => f.category === "easel_sign").map(
      (f) => f.label,
    );
    expect(labels).toEqual(["Foamcore 22×28", "Foamcore 24×36"]);
  });
});

describe("formatForKey", () => {
  it("resolves a known key, and returns undefined for custom/blank/unknown", () => {
    expect(formatForKey("foamcore-22x28")?.size).toBe("22x28");
    expect(formatForKey("")).toBeUndefined();
    expect(formatForKey(null)).toBeUndefined();
    expect(formatForKey("__custom__")).toBeUndefined();
    expect(formatForKey("nope")).toBeUndefined();
  });
});

describe("formatForSize", () => {
  it("resolves a canonical size to its format", () => {
    expect(formatForSize("4'x8' Double")?.key).toBe("meterboard-double");
    expect(formatForSize("Socks")?.key).toBe("socks");
  });

  it("returns undefined for an off-format size (the 24\"x36\" twin is a cleanup case, not a format)", () => {
    expect(formatForSize('24"x36"')).toBeUndefined();
    expect(formatForSize("24x36")?.key).toBe("foamcore-24x36"); // the canonical one
    expect(formatForSize("something custom")).toBeUndefined();
    expect(formatForSize("")).toBeUndefined();
  });
});

describe("formatBucketForSize / formatBucketOrder", () => {
  it("buckets each canonical size to its own format bucket (single ≠ double)", () => {
    expect(formatBucketForSize("22x28").key).toBe("foamcore-22x28");
    expect(formatBucketForSize("4'x8' Single").key).toBe("meterboard-single");
    expect(formatBucketForSize("4'x8' Double").key).toBe("meterboard-double");
    expect(formatBucketForSize("Socks").key).toBe("socks");
    // The two meterboard faces never collapse into one bucket.
    expect(formatBucketForSize("4'x8' Single").key).not.toBe(
      formatBucketForSize("4'x8' Double").key,
    );
  });

  it("collapses every off-format/custom size into the single custom bucket", () => {
    expect(formatBucketForSize('24"x36"').key).toBe(CUSTOM_BUCKET_KEY); // the off-format twin
    expect(formatBucketForSize("something weird").key).toBe(CUSTOM_BUCKET_KEY);
    expect(formatBucketForSize("").key).toBe(CUSTOM_BUCKET_KEY);
    expect(formatBucketForSize(null).key).toBe(CUSTOM_BUCKET_KEY);
    // One shared label, so distinct custom sizes don't spawn a batch-per-variant.
    expect(formatBucketForSize('24"x36"').label).toBe(
      formatBucketForSize("something weird").label,
    );
  });

  it("orders canonical buckets by SIGN_FORMATS order and the custom bucket last", () => {
    const order = SIGN_FORMATS.map((f) => formatBucketOrder(f.key));
    // strictly increasing in table order
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
    // custom sorts after every real format
    expect(formatBucketOrder(CUSTOM_BUCKET_KEY)).toBeGreaterThan(
      Math.max(...order),
    );
  });
});

const tupleFor = (key: string) => {
  const f = formatForKey(key)!;
  return {
    size: f.size,
    signType: f.signType,
    category: f.category,
    doubleSided: f.doubleSided,
  };
};

describe("formatTupleDiffers", () => {
  it("is false for an identical tuple and true when any identity field moves", () => {
    const base = tupleFor("foamcore-22x28");
    expect(formatTupleDiffers(base, { ...base })).toBe(false);
    expect(formatTupleDiffers(base, { ...base, size: "24x36" })).toBe(true);
    expect(formatTupleDiffers(base, { ...base, signType: '24"x36"' })).toBe(true);
    expect(formatTupleDiffers(base, { ...base, category: "meterboard" })).toBe(true);
    expect(formatTupleDiffers(base, { ...base, doubleSided: true })).toBe(true);
  });

  it("catches a change that keeps the same size string (category only)", () => {
    // The drift case: size byte-identical, category differs → still a reformat.
    const a = { size: "24x36", signType: '24"x36"', category: "ops_map", doubleSided: false };
    const b = { size: "24x36", signType: '24"x36"', category: "easel_sign", doubleSided: false };
    expect(formatTupleDiffers(a, b)).toBe(true);
  });
});

describe("formatLabelForSign (change-history label, full tuple)", () => {
  it("uses the canonical format label for an exact tuple match", () => {
    expect(formatLabelForSign(tupleFor("foamcore-22x28"))).toBe("Foamcore 22×28");
    expect(formatLabelForSign(tupleFor("meterboard-double"))).toBe(
      "Meterboard 4'×8' Double",
    );
  });

  it("renders single vs double distinctly (never 'X → X')", () => {
    expect(formatLabelForSign(tupleFor("meterboard-single"))).not.toBe(
      formatLabelForSign(tupleFor("meterboard-double")),
    );
    // Same custom size, differing only in double-sided, still reads distinctly.
    const base = { size: "5x9 custom", signType: "custom", category: "meterboard" };
    expect(formatLabelForSign({ ...base, doubleSided: false })).toBe("5x9 custom");
    expect(formatLabelForSign({ ...base, doubleSided: true })).toBe(
      "5x9 custom (2-sided)",
    );
  });

  it("does NOT borrow a canonical label for a row whose tuple isn't canonical", () => {
    // A mis-typed row: size coincides with a canonical size, but category differs.
    // Borrowing 'Foamcore 24×36' here is exactly what produced 'X → X' collisions,
    // so it must fall back to the raw size instead.
    const misTyped = {
      size: "24x36",
      signType: '24"x36"',
      category: "ops_map",
      doubleSided: false,
    };
    expect(formatLabelForSign(misTyped)).toBe("24x36");
    // …and that differs from the canonical foamcore label it normalizes TO.
    expect(formatLabelForSign(misTyped)).not.toBe(
      formatLabelForSign(tupleFor("foamcore-24x36")),
    );
  });

  it("collapses an empty size to —", () => {
    expect(
      formatLabelForSign({
        size: null,
        signType: null,
        category: null,
        doubleSided: false,
      }),
    ).toBe("—");
  });
});

describe("table agrees with the size-string derivations", () => {
  // The Format table and lib/print-summary's regex derivations must agree on every
  // canonical size — otherwise import (which derives) and the picker/audit (which use
  // the table) would disagree. Category always agrees; signType agrees EXCEPT for the
  // printed ops maps, where the table deliberately overrides the dimension-derived
  // type ("Meterboard (4'x8')" / "24\"x36\"") with the printed string — which is
  // exactly why the audit keys off the table, not the raw regex.
  it("category matches categoryFromSize for every format", () => {
    for (const f of SIGN_FORMATS) {
      expect(categoryFromSize(f.size)).toBe(f.category);
    }
  });

  it("signType matches signTypeFromSize except for the printed ops maps", () => {
    for (const f of SIGN_FORMATS) {
      if (f.category === "ops_map") {
        // Table overrides the meterboard/foamcore type the dimension regex would give.
        expect(f.signType).toBe(f.size);
        expect(signTypeFromSize(f.size)).not.toBe(f.signType);
      } else {
        expect(signTypeFromSize(f.size)).toBe(f.signType);
      }
    }
  });
});
