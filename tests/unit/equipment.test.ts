import { describe, it, expect } from "vitest";

import { conLabelForYear, conNumberForYear, DC_EPOCH } from "@/lib/con-config";
import {
  ASSET_CATEGORIES,
  assetsToOrder,
  CATEGORY_OPTIONS,
  classifyKind,
  effectiveOnHand,
  reconcileAssets,
  signMaterialCountsFromSummary,
  type AssetItem,
} from "@/lib/equipment";
import type { PrintSummary } from "@/lib/print-summary";

describe("con-number mapping", () => {
  it("derives the epoch from CON_YEAR/CON_SLUG (2025 = DC33 -> 1992)", () => {
    expect(DC_EPOCH).toBe(1992);
  });

  it("maps calendar year -> con number / label", () => {
    expect(conNumberForYear(2025)).toBe(33);
    expect(conLabelForYear(2025)).toBe("DC33");
    expect(conLabelForYear(2026)).toBe("DC34");
    expect(conLabelForYear(2022)).toBe("DC30");
  });
});

describe("classifyKind", () => {
  it("routes sign material to history-only", () => {
    expect(classifyKind("Sign Material")).toBe("sign_material");
    expect(classifyKind("sign material")).toBe("sign_material"); // case-insensitive
  });

  it("routes the asset categories to asset", () => {
    for (const c of ASSET_CATEGORIES) {
      expect(classifyKind(c)).toBe("asset");
      expect(classifyKind(c.toLowerCase())).toBe("asset");
    }
  });

  it("treats everything else (incl. null/blank/custom) as consumable", () => {
    expect(classifyKind(null)).toBe("consumable");
    expect(classifyKind("")).toBe("consumable");
    expect(classifyKind("Consumable")).toBe("consumable");
    expect(classifyKind("Supplies")).toBe("consumable");
    expect(classifyKind("Fasteners")).toBe("consumable");
  });

  it("offers the asset categories + Consumable as add/edit options", () => {
    expect(CATEGORY_OPTIONS).toEqual([...ASSET_CATEGORIES, "Consumable"]);
  });
});

describe("effectiveOnHand", () => {
  const base: AssetItem = {
    id: 1,
    name: "Tent Pole Easels",
    category: "Easel",
    onHand: 0,
    priorEndOfCon: 114,
    ordered: 0,
    received: 0,
    endOfCon: 0,
    notes: null,
    hasInventoryRow: false,
  };

  it("uses an explicit start-of-con count when entered (>0)", () => {
    expect(effectiveOnHand({ ...base, onHand: 40, hasInventoryRow: true })).toBe(40);
  });

  it("carries forward last year's end-of-con when no start was entered", () => {
    expect(effectiveOnHand(base)).toBe(114);
  });

  it("carries forward even when an end-of-con-only row exists (the DC33 case)", () => {
    // A row exists (hasInventoryRow) but no start-of-con was entered (onHand 0),
    // so it must carry base.priorEndOfCon (114) forward, not show 0.
    expect(effectiveOnHand({ ...base, hasInventoryRow: true })).toBe(114);
  });

  it("falls back to 0 when there's neither a start nor prior history", () => {
    expect(effectiveOnHand({ ...base, priorEndOfCon: null })).toBe(0);
  });
});

describe("reconcileAssets", () => {
  const item = (over: Partial<AssetItem>): AssetItem => ({
    id: 0,
    name: "x",
    category: "Easel",
    onHand: 0,
    priorEndOfCon: null,
    ordered: 0,
    received: 0,
    endOfCon: 0,
    notes: null,
    hasInventoryRow: false,
    ...over,
  });

  it("groups by category, sums have, derives gap = max(0, need - have)", () => {
    const items = [
      item({ id: 1, name: "Tent Pole Easels", category: "Easel", onHand: 114, hasInventoryRow: true }),
      item({ id: 2, name: "Silver Tripod Easels", category: "Easel", onHand: 7, hasInventoryRow: true }),
      item({ id: 3, name: "Screw Meterboards", category: "Meterboard", onHand: 38, hasInventoryRow: true }),
    ];
    const recon = reconcileAssets(items, { Easel: 131, Meterboard: 84 });

    const easels = recon.find((r) => r.category === "Easel")!;
    expect(easels.have).toBe(121);
    expect(easels.need).toBe(131);
    expect(easels.gap).toBe(10);

    const mb = recon.find((r) => r.category === "Meterboard")!;
    expect(mb.have).toBe(38);
    expect(mb.gap).toBe(46);
  });

  it("clamps gap at 0 when supply exceeds need", () => {
    const recon = reconcileAssets(
      [item({ id: 1, category: "Easel", onHand: 200, hasInventoryRow: true })],
      { Easel: 131 },
    );
    expect(recon[0].gap).toBe(0);
  });

  it("leaves need/gap null for categories with no derived need", () => {
    const recon = reconcileAssets(
      [item({ id: 1, category: "Stand", onHand: 13, hasInventoryRow: true })],
      { Easel: 131 },
    );
    expect(recon[0].need).toBeNull();
    expect(recon[0].gap).toBeNull();
    expect(recon[0].have).toBe(13);
  });

  it("orders known asset categories first, then others alphabetically", () => {
    const recon = reconcileAssets(
      [
        item({ id: 1, category: "Stand" }),
        item({ id: 2, category: "Easel" }),
        item({ id: 3, category: "Zebra" }),
        item({ id: 4, category: "Meterboard" }),
      ],
      {},
    );
    expect(recon.map((r) => r.category)).toEqual([
      "Easel",
      "Meterboard",
      "Stand",
      "Zebra",
    ]);
  });

  it("carry-forward feeds 'have' when the current year has no row", () => {
    const recon = reconcileAssets(
      [item({ id: 1, category: "Easel", hasInventoryRow: false, priorEndOfCon: 68 })],
      { Easel: 100 },
    );
    expect(recon[0].have).toBe(68);
    expect(recon[0].gap).toBe(32);
  });
});

describe("assetsToOrder", () => {
  it("returns only categories with a positive gap", () => {
    const items = [
      item({ id: 1, category: "Easel", onHand: 50, hasInventoryRow: true }),
      item({ id: 2, category: "Meterboard", onHand: 100, hasInventoryRow: true }),
      item({ id: 3, category: "Stand", onHand: 5, hasInventoryRow: true }),
    ];
    const recon = reconcileAssets(items, { Easel: 80, Meterboard: 40 });
    expect(assetsToOrder(recon)).toEqual([{ category: "Easel", gap: 30 }]);
  });

  // shared item factory mirrors reconcileAssets' tests
  function item(over: Partial<AssetItem>): AssetItem {
    return {
      id: 0,
      name: "x",
      category: "Easel",
      onHand: 0,
      priorEndOfCon: null,
      ordered: 0,
      received: 0,
      endOfCon: 0,
      notes: null,
      hasInventoryRow: false,
      ...over,
    };
  }
});

describe("signMaterialCountsFromSummary", () => {
  const summary: PrintSummary = {
    materials: [
      { key: "22x28", label: '22" x 28"', single: 80, double: 2, total: 82 },
      { key: "24x36", label: '24" x 36"', single: 49, double: 0, total: 49 },
      { key: "meterboard", label: "Meterboard (4x8)", single: 14, double: 71, total: 85 },
      { key: "floor", label: "Floor graphic", single: 4, double: 0, total: 4 },
      { key: "other", label: "Other / unspecified", single: 10, double: 0, total: 10 },
    ],
    easelsRequired: 126,
    meterboardStands: 85,
    totalSigns: 230,
  };

  it("maps print-summary buckets to the six history rows", () => {
    expect(signMaterialCountsFromSummary(summary)).toEqual({
      "Signs 22x28": 82,
      "Signs 24x36": 49,
      "Meterboard Signs (Single)": 14,
      "Meterboard Signs (Double)": 71,
      "Floor Graphics": 4,
      "Easels Required": 126,
    });
  });

  it("defaults missing buckets to 0", () => {
    const empty: PrintSummary = {
      materials: [],
      easelsRequired: 0,
      meterboardStands: 0,
      totalSigns: 0,
    };
    expect(signMaterialCountsFromSummary(empty)).toEqual({
      "Signs 22x28": 0,
      "Signs 24x36": 0,
      "Meterboard Signs (Single)": 0,
      "Meterboard Signs (Double)": 0,
      "Floor Graphics": 0,
      "Easels Required": 0,
    });
  });
});
