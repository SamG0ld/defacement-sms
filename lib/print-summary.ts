// Derive the "print summary" (sheet 6's auto-counted section) from aggregated
// sign data: counts by material x single/double, easels required, meterboard
// stands. Operates on DB-side groupBy results (a handful of rows) rather than
// every sign, so it stays cheap as the table grows.

import type { SignCategory } from "@/app/generated/prisma/enums";

export type SizeGroup = {
  category: SignCategory;
  size: string;
  doubleSided: boolean;
  needsEasel: boolean;
  printable: boolean;
  quantity: number; // summed across signs of this (category, size, doubleSided, needsEasel, printable)
};

export type MaterialCount = {
  key: string;
  label: string;
  single: number;
  double: number;
  total: number;
};

export type PrintSummary = {
  materials: MaterialCount[];
  easelsRequired: number;
  meterboardStands: number;
  totalSigns: number;
};

// Classify a free-text size string into a material bucket. Order is
// load-bearing: more specific patterns first so e.g. "4x8 banner" -> banner,
// not meterboard.
function bucket(size: string): { key: string; label: string } {
  const s = size.toLowerCase();
  if (/22\s*"?\s*x\s*28/.test(s)) return { key: "22x28", label: '22" x 28"' };
  if (/24\s*"?\s*x\s*36/.test(s)) return { key: "24x36", label: '24" x 36"' };
  if (/sock|21\s*"?\s*x\s*42|flying/.test(s)) {
    return { key: "socks", label: "Flying socks (21x42)" };
  }
  if (/floor graphic/.test(s)) return { key: "floor", label: "Floor graphic" };
  if (/wall graphic/.test(s)) return { key: "wall", label: "Wall graphic" };
  if (/u\s*shape|venue map/.test(s)) {
    return { key: "venue-map", label: "Venue map (U-shape)" };
  }
  if (/banner/.test(s)) return { key: "banner", label: "Banner" };
  if (/meter\s*board|4'?\s*x\s*8|4\s*x\s*8/.test(s)) {
    return { key: "meterboard", label: "Meterboard (4x8)" };
  }
  return { key: "other", label: "Other / unspecified" };
}

// Whether a size string denotes a meterboard (4x8) sign. Reuses the same
// classifier as the print summary so the priority rules hold (e.g. "4x8 banner"
// is a banner, not a meterboard). Used to decide a sign needs a meterboard stand.
export function isMeterboard(size: string): boolean {
  return bucket(size).key === "meterboard";
}

// The real sign-type vocabulary — physical forms scoped to what the team has
// actually used. A plain sign is denoted by its size (22"x28" / 24"x36"); the
// rest name a form factor. Drives the create/edit <datalist> (re-exported as
// SIGN_TYPES) and is the target set for signTypeFromSize.
export const SIGN_FORM_TYPES = [
  '22"x28"',
  '24"x36"',
  "Meterboard (4'x8')",
  "Banner",
  "Socks",
  "8'x20'",
] as const;

// Derive a sign's type (form factor) from its size string using the same bucket
// classifier as the print summary. Plain sizes map to their dimension type;
// meterboard/banner/socks/8x20 map to their form. Falls back to the generic
// "Sign" for sizes that don't match a known form (a handful of odd one-offs).
export function signTypeFromSize(size: string): string {
  switch (bucket(size).key) {
    case "22x28":
      return '22"x28"';
    case "24x36":
      return '24"x36"';
    case "meterboard":
      return "Meterboard (4'x8')";
    case "banner":
      return "Banner";
    case "socks":
      return "Socks";
    default:
      if (/8'?\s*x\s*20/.test(size.toLowerCase())) return "8'x20'";
      return "Sign";
  }
}

// Derive a sign's physical item class from its size string. Size-only fallback for
// the generic importer / manual entry; the sign-sheet parser prefers sectionCategory
// (the sheet's own section structure) and uses this when no section is in scope.
// Order is load-bearing: "(printed)" paper maps win over their dimensions (a paper
// "4'x8' (printed)" venue map is an ops_map, not a meterboard), and 8'x20' / banner
// win over the generic 4x8 meterboard match. Mirrors the migration backfill CASE.
export function categoryFromSize(size: string): SignCategory {
  const s = size.toLowerCase();
  if (/printed/.test(s)) return "ops_map";
  if (/sock|21\s*"?\s*x\s*42|flying/.test(s)) return "socks";
  if (/8'?\s*x\s*20|banner/.test(s)) return "union_installed";
  if (/floor graphic|wall graphic|sticker wall/.test(s)) return "union_installed";
  if (/22\s*"?\s*x\s*28/.test(s)) return "easel_sign";
  if (/24\s*"?\s*x\s*36/.test(s)) return "easel_sign";
  if (/meter\s*board|4'?\s*x\s*8/.test(s)) return "meterboard";
  return "other";
}

// Map a sign-sheet *section header* to a category. The DC33 sheet is organized into
// material/class sections ("Command Maps", "22\" x 28\"", "Flying Signs (Socks)",
// "Foamcore Banners", "Meter Boards", ...) — the section is more authoritative than a
// per-row size guess. Returns null when the label isn't a recognized class section.
// Order is load-bearing (command-map before its "not meterboard/socks" disclaimer;
// banner/foamcore before the 4x8 meterboard match).
export function sectionCategory(label: string): SignCategory | null {
  const t = label.toLowerCase();
  if (/command map/.test(t)) return "ops_map";
  if (/sock|flying|21\s*"?\s*x\s*42/.test(t)) return "socks";
  if (/banner|foamcore|8'?\s*x\s*4|8'?\s*x\s*20/.test(t)) return "union_installed";
  if (/floor graphic|wall graphic|sticker wall/.test(t)) return "union_installed";
  if (/meter\s*board/.test(t)) return "meterboard";
  if (/venue map|u\s*shape|stretch fabric/.test(t)) return "ops_map";
  if (/22\s*"?\s*x\s*28|24\s*"?\s*x\s*36/.test(t)) return "easel_sign";
  return null;
}

// Material bucket for the print-run breakdown — category-aware so the two cases
// where size alone misleads are routed correctly: paper ops maps (a "4x8 (printed)"
// venue map is NOT a meterboard) and union-installed items (banners / floor / wall
// graphics) get their own lines instead of polluting meterboard / "other". Plain
// classes fall through to the size-based `bucket()` (22x28 / 24x36 / socks / ...).
function materialBucket(
  category: SignCategory,
  size: string,
): { key: string; label: string } {
  if (category === "ops_map") {
    return { key: "ops-map", label: "Venue / ops map (paper)" };
  }
  if (category === "union_installed") {
    const s = size.toLowerCase();
    if (/floor graphic/.test(s)) return { key: "floor", label: "Floor graphic" };
    if (/wall graphic/.test(s)) return { key: "wall", label: "Wall graphic" };
    return { key: "banner", label: "Banner / union-installed" };
  }
  return bucket(size);
}

// Per-category counts from aggregated sign groups. Three rules differ from a naive
// size tally: easels honor the per-sign Easel Y/N flag (Σ needsEasel·qty, incl. bare
// "(easels only)" rows), meterboard stands count the `meterboard` *category* (so paper
// maps don't add stands), and only `printable` rows count toward the print run (bare
// easels need an easel but print nothing). Material keys 22x28/24x36/meterboard/floor
// are preserved for signMaterialCountsFromSummary (the equipment-history writer).
export function computePrintSummary(groups: SizeGroup[]): PrintSummary {
  const map = new Map<string, MaterialCount>();
  let meterboardStands = 0;
  let easelsRequired = 0;
  let totalSigns = 0;

  for (const g of groups) {
    const qty = g.quantity > 0 ? g.quantity : 0;
    if (g.needsEasel) easelsRequired += qty; // honor the Easel Y/N marking
    if (g.category === "meterboard") meterboardStands += qty;
    if (!g.printable) continue; // bare easels: counted above, not a print

    totalSigns += qty;
    const b = materialBucket(g.category, g.size);
    if (!map.has(b.key)) {
      map.set(b.key, { key: b.key, label: b.label, single: 0, double: 0, total: 0 });
    }
    const m = map.get(b.key)!;
    if (g.doubleSided) m.double += qty;
    else m.single += qty;
    m.total += qty;
  }

  const materials = [...map.values()].sort((a, b) => b.total - a.total);
  return { materials, easelsRequired, meterboardStands, totalSigns };
}
