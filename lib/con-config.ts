// Current-con identity for the CSV import tooling. The sign-sheet and master
// parsers (app/(app)/signs/import/_parsers/*) are reused year over year; these
// constants are the only things that change between cons, so they live here
// instead of being scattered through the parsers. Override via env so a new con
// needs no source edit; the defaults track the most recently imported con (DC33,
// held in 2025). Pairs with the one-file theme swap in app/theme.css.
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
// inventory — a standard 22"x28" poster. Not con-specific, but kept here as the
// single home for the import defaults.
export const ROOM_ID_SIGN_SIZE = "22x28";

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
