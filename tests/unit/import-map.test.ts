import { describe, it, expect } from "vitest";

import {
  buildPreview,
  categorizeRows,
  cell,
  clampQuantity,
  isTruthy,
  mapHeaders,
  normalizeSlot,
  resolveTags,
  resolveTagSlugs,
  resolveZone,
  slugify,
  tooManyRows,
  MAX_IMPORT_ROWS,
  type RowDraft,
  type SignData,
} from "@/app/(app)/signs/import/_map";
import { makeCtx } from "../helpers/mapping-context";

describe("mapHeaders", () => {
  it("maps known aliases to column indexes", () => {
    const map = mapHeaders(["Map#", "Sign Text", "Qty", "Location"]);
    expect(map).toEqual({
      itemId: 0,
      signText: 1,
      quantity: 2,
      placementArea: 3,
    });
  });
});

describe("small field helpers", () => {
  it("slugify", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  A & B  ")).toBe("a-b");
  });

  it("normalizeSlot", () => {
    expect(normalizeSlot("Weds AM")).toBe("WED_AM");
    expect(normalizeSlot("THURS_PM")).toBe("THU_PM");
    expect(normalizeSlot("tue am")).toBe("TUES_AM");
    expect(normalizeSlot("nonsense")).toBeNull();
  });

  it("cell trims and tolerates undefined index", () => {
    expect(cell([" x "], 0)).toBe("x");
    expect(cell(["a", "b"], 1)).toBe("b");
    expect(cell(["a"], undefined)).toBe("");
  });

  it("clampQuantity coerces into [1, 999]", () => {
    expect(clampQuantity("5")).toBe(5);
    expect(clampQuantity("0")).toBe(1);
    expect(clampQuantity("9999")).toBe(999);
    expect(clampQuantity("abc")).toBe(1);
    expect(clampQuantity("")).toBe(1);
  });

  it("isTruthy", () => {
    expect(isTruthy("yes")).toBe(true);
    expect(isTruthy("X")).toBe(true);
    expect(isTruthy("no")).toBe(false);
    expect(isTruthy("")).toBe(false);
  });
});

describe("tooManyRows", () => {
  it("caps above MAX_IMPORT_ROWS", () => {
    expect(tooManyRows(MAX_IMPORT_ROWS)).toBeNull();
    const over = tooManyRows(MAX_IMPORT_ROWS + 1);
    expect(over?.headerError).toMatch(/too many rows/i);
  });
});

describe("categorizeRows", () => {
  const base: SignData = {
    itemId: "A",
    signText: "Sign A",
    signType: "Sign",
    size: "22x28",
    quantity: 1,
    doubleSided: false,
    needsEasel: false,
    placementArea: null,
    notes: null,
    deploymentSlot: null,
    zoneId: null,
  };
  const draft = (data: SignData, line: number): RowDraft => ({
    line,
    data,
    tagSlugs: [],
    warnings: [],
  });

  it("marks valid / invalid / duplicate (DB and in-file)", () => {
    const drafts: RowDraft[] = [
      draft(base, 1), // valid
      draft({ ...base, signText: "" }, 2), // invalid (schema)
      draft({ ...base, itemId: "B", signText: "Sign B" }, 3), // dup vs DB
      draft(base, 4), // dup of row 1 within the file
    ];
    const ctx = makeCtx({ existingKeys: ["B Sign B"] });
    const preview = categorizeRows(drafts, ctx, {
      mappedColumns: [],
      ignoredHeaders: [],
    });

    expect(preview.counts).toEqual({
      valid: 1,
      invalid: 1,
      duplicate: 2,
      total: 4,
    });
    expect(preview.rows[1].status).toBe("invalid");
    expect(preview.rows[1].reason).toMatch(/sign text/i);
    expect(preview.rows[2].status).toBe("duplicate");
    expect(preview.rows[3].status).toBe("duplicate");
  });
});

describe("resolve helpers", () => {
  const ctx = makeCtx({
    zones: { "LVCC-L1": 1 },
    tagSlugs: ["village", "contest"],
  });

  it("resolveZone maps known codes and warns on unknown", () => {
    const warnings: string[] = [];
    expect(resolveZone("lvcc-l1", ctx, warnings)).toBe(1);
    expect(resolveZone("", ctx, warnings)).toBeNull();
    expect(resolveZone("NOPE", ctx, warnings)).toBeNull();
    expect(warnings.some((w) => /unknown zone/i.test(w))).toBe(true);
  });

  it("resolveTags splits a free-text cell and keeps known slugs", () => {
    const warnings: string[] = [];
    expect(resolveTags("Village, Contest", ctx, warnings)).toEqual([
      "village",
      "contest",
    ]);
    expect(resolveTags("Village; Ghost", ctx, warnings)).toEqual(["village"]);
    expect(warnings.some((w) => /unknown tag/i.test(w))).toBe(true);
    expect(resolveTags("", ctx, warnings)).toEqual([]);
  });

  it("resolveTagSlugs filters to known slugs", () => {
    const warnings: string[] = [];
    expect(resolveTagSlugs(["village", "ghost"], ctx, warnings)).toEqual([
      "village",
    ]);
  });
});

describe("buildPreview (generic CSV)", () => {
  const header = ["Map#", "Sign Text", "Size", "Qty", "Zone", "Tags", "Deploy"];
  const ctx = makeCtx({ zones: { "LVCC-L1": 1 }, tagSlugs: ["village"] });

  it("errors when required columns are missing", () => {
    const preview = buildPreview([["Foo", "Bar"], ["1", "2"]], ctx);
    expect(preview.headerError).toMatch(/missing required column/i);
  });

  it("errors on an empty file", () => {
    expect(buildPreview([], ctx).headerError).toMatch(/empty/i);
  });

  it("maps rows, applies defaults, resolves zone/tags/slot", () => {
    const preview = buildPreview(
      [header, ["A1", "Sign One", "", "2", "LVCC-L1", "village", "FRI_PM"]],
      ctx,
    );
    expect(preview.headerError).toBeNull();
    expect(preview.counts.valid).toBe(1);
    const d = preview.rows[0].data;
    expect(d.size).toBe("Unspecified"); // default when blank
    expect(d.quantity).toBe(2);
    expect(d.zoneId).toBe(1);
    expect(d.deploymentSlot).toBe("FRI_PM");
    expect(preview.rows[0].tagSlugs).toEqual(["village"]);
  });

  it("skips fully blank rows", () => {
    const preview = buildPreview(
      [
        header,
        ["", "", "", "", "", "", ""],
        ["A2", "Sign Two", "", "1", "", "", ""],
      ],
      ctx,
    );
    expect(preview.counts.total).toBe(1);
  });
});
