// Equipment classification + asset reconciliation. Pure + server-safe so it can
// be unit-tested without a DB. The /inventory page groups equipment into three
// kinds and reconciles durable assets against the (live-derived) need.
//
// Kinds are derived from the free-text `category` column rather than a dedicated
// schema field — keeps Phase 1 migration-free. A dedicated `kind`/`archivedAt`
// column is a deferred enhancement (see plans).

import type { PrintSummary } from "./print-summary";

export type EquipmentKind = "asset" | "consumable" | "sign_material";

// Durable hardware the team owns, stores, and re-counts each year. Order is the
// display order for the asset section's category groups.
export const ASSET_CATEGORIES = [
  "Easel",
  "Meterboard",
  "Stand",
  "Banner",
] as const;

// Categories whose totals are derived live from the sign list (print summary)
// and therefore are NOT manually inventoried — kept only in year-over-year.
const SIGN_MATERIAL_CATEGORY = "sign material";

// The category <select> options offered when adding/editing an item. Anything
// not in ASSET_CATEGORIES is treated as a consumable.
export const CATEGORY_OPTIONS = [...ASSET_CATEGORIES, "Consumable"] as const;

const ASSET_SET = new Set<string>(ASSET_CATEGORIES.map((c) => c.toLowerCase()));

// Classify an equipment type by its (free-text) category into one of the three
// page sections. Unknown / blank / custom categories are consumables.
export function classifyKind(category: string | null | undefined): EquipmentKind {
  const c = (category ?? "").trim().toLowerCase();
  if (c === SIGN_MATERIAL_CATEGORY) return "sign_material";
  if (ASSET_SET.has(c)) return "asset";
  return "consumable";
}

// A durable-asset row, normalized from EquipmentType + its inventory for a year.
export type AssetItem = {
  id: number;
  name: string;
  category: string;
  onHand: number; // current-year count_start_of_con
  priorEndOfCon: number | null; // last year's count_end_of_con (carry-forward)
  ordered: number;
  received: number;
  endOfCon: number;
  notes: string | null;
  hasInventoryRow: boolean; // a row exists for the selected year
};

export type AssetItemResolved = AssetItem & { effectiveOnHand: number };

export type CategoryReconciliation = {
  category: string;
  need: number | null; // derived where possible; null = not derivable
  have: number; // sum of effective on-hand across the category's items
  gap: number | null; // max(0, need - have) when need is known
  items: AssetItemResolved[];
};

// "Have on hand" for the year = what carried over from last year's end-of-con,
// unless an explicit start-of-con count was entered for this year. Keying off
// onHand > 0 (not row existence) matters: recording only an end-of-con count
// leaves start-of-con 0, and we must still carry the prior end-of-con forward
// rather than show 0.
export function effectiveOnHand(item: AssetItem): number {
  return item.onHand > 0 ? item.onHand : item.priorEndOfCon ?? 0;
}

// Reconcile durable assets into per-category Need / Have / Gap. `derivedNeed` is
// keyed by category (e.g. { Easel: easelsRequired, Meterboard: meterboardStands });
// categories absent from it have an unknown (null) need.
export function reconcileAssets(
  items: AssetItem[],
  derivedNeed: Record<string, number> = {},
): CategoryReconciliation[] {
  const byCategory = new Map<string, AssetItemResolved[]>();
  for (const item of items) {
    const resolved = { ...item, effectiveOnHand: effectiveOnHand(item) };
    const list = byCategory.get(item.category);
    if (list) list.push(resolved);
    else byCategory.set(item.category, [resolved]);
  }

  // Stable display order: known asset categories first (ASSET_CATEGORIES order),
  // then any other category alphabetically.
  const order = (cat: string): number => {
    const i = ASSET_CATEGORIES.indexOf(cat as (typeof ASSET_CATEGORIES)[number]);
    return i === -1 ? ASSET_CATEGORIES.length : i;
  };
  const categories = [...byCategory.keys()].sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  );

  return categories.map((category) => {
    const list = byCategory
      .get(category)!
      .sort((a, b) => a.name.localeCompare(b.name));
    const have = list.reduce((sum, i) => sum + i.effectiveOnHand, 0);
    const need = category in derivedNeed ? derivedNeed[category] : null;
    const gap = need === null ? null : Math.max(0, need - have);
    return { category, need, have, gap, items: list };
  });
}

// The categories that still need ordering (gap > 0) — the actionable rollup
// shown as the "to order" strip.
export function assetsToOrder(
  reconciliation: CategoryReconciliation[],
): { category: string; gap: number }[] {
  return reconciliation
    .filter((c) => c.gap !== null && c.gap > 0)
    .map((c) => ({ category: c.category, gap: c.gap as number }));
}

// ----- Sign-material history derivation -----
//
// The six "Sign Material" equipment types are NOT manually inventoried — their
// per-con totals are exactly what the live print summary already computes from
// the sign list. This bridges the print summary -> those named history rows so a
// completed con's totals can be recorded into year-over-year from the imported
// signs (instead of being hand-typed). Names must match prisma/seeds/equipment-types.sql.
export const SIGN_MATERIAL_TYPE_NAMES = [
  "Signs 22x28",
  "Signs 24x36",
  "Meterboard Signs (Single)",
  "Meterboard Signs (Double)",
  "Floor Graphics",
  "Easels Required",
] as const;

export function signMaterialCountsFromSummary(
  summary: PrintSummary,
): Record<string, number> {
  const bucket = (key: string) => summary.materials.find((m) => m.key === key);
  return {
    "Signs 22x28": bucket("22x28")?.total ?? 0,
    "Signs 24x36": bucket("24x36")?.total ?? 0,
    "Meterboard Signs (Single)": bucket("meterboard")?.single ?? 0,
    "Meterboard Signs (Double)": bucket("meterboard")?.double ?? 0,
    "Floor Graphics": bucket("floor")?.total ?? 0,
    "Easels Required": summary.easelsRequired,
  };
}
