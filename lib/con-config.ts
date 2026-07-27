// Current-con identity for the CSV import tooling. The sign-sheet and master
// parsers (app/(app)/signs/import/_parsers/*) are reused year over year; these
// constants are the only things that change between cons, so they live here
// instead of being scattered through the parsers. Override via env so a new con
// needs no source edit; the defaults track the most recently imported con (DC33,
// held in 2025). Pairs with the one-file theme swap in app/theme.css. When bumping
// these defaults for a new con, also update any deployment manifest that pins
// CON_YEAR/CON_SLUG explicitly so every environment shares prod's import behavior.
//
// (File is con-config.ts, not con.ts: "con" is a reserved device name on Windows,
// which breaks git and tooling on Windows checkouts.)

// Year the imported sheet's dates belong to — used to resolve the deploy-by
// matrix headers and the rotating-event time windows, which carry only a
// month/day in the source.
export const CON_YEAR: number = Number(process.env.CON_YEAR) || 2025;

// Short con slug, used to prefix the stable synthetic ids generated for
// sign-sheet rows with a blank Map#. Keep this consistent across re-imports of
// the same sheet or dedup breaks (the prefix is part of the id).
export const CON_SLUG: string = process.env.CON_SLUG?.trim() || "DC33";

// Default size for room-ID signs generated one-per-space from the Master
// inventory — a standard 22"x28" foamcore sign. The fallback when a space's
// department matches no rule in DEPT_RULES below.
export const ROOM_ID_SIGN_SIZE = "22x28";

// Department rules for the Master inventory import — the single source of truth for
// the dept correlation, used for BOTH the sign tag and the default size. The master
// is a space *roster* and carries no sizes; size/type tracks the **department**, a
// correlation observed across the DC32 (2024) + DC33 (2025) sign sheets. Spaces
// largely repeat con to con, so this translates each year's master into realistic
// signage instead of a flat 22"x28". All foamcore. `match` is tested against the
// lowercased Department cell (tolerant of singular/variant spellings); ORDER MATTERS
// (specific before general). categoryFromSize / signTypeFromSize / the double-sided
// check derive the rest from `size`, so values must stay strings those classifiers
// recognize (see lib/print-summary.ts). Tags must exist in the sign_tags seed. Tune
// or add a rule per new department as prior-year data accrues.
type DeptRule = { match: RegExp; tag: string | null; size: string };
const DEPT_RULES: readonly DeptRule[] = [
  // High confidence — size held across both DC32 and DC33:
  { match: /contest/, tag: "contest", size: "22x28" },
  { match: /village/, tag: "village", size: "4'x8' Double" }, // double-sided meterboard
  { match: /communit/, tag: "community", size: "4'x8' Double" },
  { match: /demo\s*lab/, tag: "demo-labs", size: "24x36" },
  { match: /creator|\bstage\b/, tag: "stage", size: "4'x8' Single" },
  { match: /\bnfo\b/, tag: "nfo", size: "4'x8' Double" },
  // 24"x36" — DC33 sized these conference-room departments up to the larger easel
  // sign (Inhuman Registration, DEF CON Workshops, A&E were all 24x36 on the DC33
  // sheet). Applied on the team lead's call from that one strong prior year.
  { match: /workshop/, tag: "workshop", size: "24x36" },
  { match: /registration|\breg\b/, tag: "registration", size: "24x36" },
  { match: /\ba&e\b|\bart.*entertain/, tag: "a-e", size: "24x36" },
  // Lower confidence — no strong prior-year signal, default to a 22"x28" sign:
  { match: /training/, tag: "training", size: "22x28" },
  { match: /\bgoon\b/, tag: "goon", size: "22x28" },
  { match: /\beac\b/, tag: "eac", size: "22x28" },
  { match: /talk/, tag: "talks", size: "22x28" },
  { match: /\bpart(?:y|ies)?\b/, tag: "party", size: "22x28" },
  { match: /vendor/, tag: "vendor", size: "22x28" },
];

function deptRule(dept: string): DeptRule | null {
  const t = dept.trim().toLowerCase();
  return DEPT_RULES.find((r) => r.match.test(t)) ?? null;
}

// Department cell -> sign tag slug (null if no rule matches).
export function departmentTag(dept: string): string | null {
  return deptRule(dept)?.tag ?? null;
}

// Every tag slug DEPT_RULES can assign — the set that marks a sign's department.
// Reconcile (M18) uses it to read a sign's current department off its tags so a
// department reclassification in the sheet surfaces as an informational flag.
export const DEPARTMENT_TAG_SLUGS: ReadonlySet<string> = new Set(
  DEPT_RULES.map((r) => r.tag).filter((t): t is string => t !== null),
);

// Pick the department tag out of a sign's tag slugs (null if it carries none).
// The master parser assigns a single department tag, but a lead could hand-assign
// two via the edit form — so iterate the canonical DEPT_RULES order (not the input
// order) and return the first present, making the result deterministic regardless of
// tag-assignment row order (keeps the informational dept-change flag from flickering).
export function departmentTagFromSlugs(slugs: Iterable<string>): string | null {
  const present = slugs instanceof Set ? slugs : new Set(slugs);
  for (const tag of DEPARTMENT_TAG_SLUGS) {
    if (present.has(tag)) return tag;
  }
  return null;
}

// Department cell -> default sign size, falling back to the room-ID size.
export function deptSize(dept: string): string {
  return deptRule(dept)?.size ?? ROOM_ID_SIGN_SIZE;
}

// Tags whose *room-based* (non-hall) spaces also get a sock — a tall flying sign
// with the room number hung high to mark the entrance above the crowd. ~25/yr
// historically, on the W2xx/W3xx conference rooms housing villages/communities; the
// open exhibition-hall booths got meterboards, not socks. Keyed by tag slug so it
// rides the same tolerant matching as departmentTag.
export const SOCK_DEPARTMENTS = new Set(["village", "community"]);

// ---- Con-number <-> calendar-year mapping --------------------------------
// Counts are stored by calendar year (unambiguous), but the team thinks in con
// numbers ("DC33"). Derive the epoch from the known CON_YEAR/CON_SLUG pair
// (2025 = DC33 -> epoch 1992) so this stays correct if the defaults change for
// a future con. Falls back to 1992 if CON_SLUG carries no digits.
const CON_NUMBER = Number(CON_SLUG.replace(/\D/g, ""));
export const DC_EPOCH = Number.isFinite(CON_NUMBER) && CON_NUMBER > 0
  ? CON_YEAR - CON_NUMBER
  : 1992;

// Calendar year -> con number (2025 -> 33).
export function conNumberForYear(year: number): number {
  return year - DC_EPOCH;
}

// Calendar year -> con label ("DC33").
export function conLabelForYear(year: number): string {
  return `DC${conNumberForYear(year)}`;
}
