// Derive the "print summary" (sheet 6's auto-counted section) from aggregated
// sign data: counts by material x single/double, easels required, meterboard
// stands. Operates on DB-side groupBy results (a handful of rows) rather than
// every sign, so it stays cheap as the table grows.

export type SizeGroup = {
  size: string;
  doubleSided: boolean;
  quantity: number; // summed across signs of this (size, doubleSided)
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

export function computePrintSummary(groups: SizeGroup[]): PrintSummary {
  const map = new Map<string, MaterialCount>();
  let meterboardStands = 0;
  let totalSigns = 0;

  for (const g of groups) {
    const qty = g.quantity > 0 ? g.quantity : 0;
    totalSigns += qty;

    const b = bucket(g.size);
    if (b.key === "meterboard") meterboardStands += qty;

    if (!map.has(b.key)) {
      map.set(b.key, { key: b.key, label: b.label, single: 0, double: 0, total: 0 });
    }
    const m = map.get(b.key)!;
    if (g.doubleSided) m.double += qty;
    else m.single += qty;
    m.total += qty;
  }

  const materials = [...map.values()].sort((a, b) => b.total - a.total);
  // Easels hold the poster-size signs: one easel per 22x28 / 24x36 sign. (The
  // per-sign `needsEasel` flag is unreliable on imported data, so we derive the
  // count from the sizes that actually go on easels.)
  const easelsRequired =
    (map.get("22x28")?.total ?? 0) + (map.get("24x36")?.total ?? 0);
  return { materials, easelsRequired, meterboardStands, totalSigns };
}
