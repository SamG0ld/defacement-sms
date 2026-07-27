// Canonicalize a room / booth code so formatting-only variants collapse to a single
// key. The master sheet writes the same physical space inconsistently — "W204, W205"
// vs "W204-W205", "W219 -W220" vs "W219, W220", "W226, W227" vs "W226-W227". Each
// spelling was a different string, so the reconcile/import IDENTITY treated them as
// different spaces and created duplicate signs (a meterboard + a sock per variant).
//
// The M18 reconcile identity and the import dedup key use THIS (not the raw string)
// for the room component, so a space entered under two spellings maps to one identity
// and can't spawn a twin. The RAW itemId is still stored + printed as the Room — this
// only affects matching.
//
// Deliberately conservative: it unifies separators and case, but does NOT fix typos
// ("1W05"), reorder tokens, or expand ranges. Over-merging two genuinely different
// spaces is a worse failure than leaving a typo for the audit (lib/sign-audit.ts) to
// flag for a human — so anything it can't collapse safely stays distinct and visible.
export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s,+/&]+/g, "-") // unify separator runs (space, comma, plus, slash, &) -> one hyphen
    .replace(/-+/g, "-") // collapse hyphen runs (e.g. "W219 -W220" -> "W219--W220" -> "W219-W220")
    .replace(/^-+|-+$/g, ""); // trim edge hyphens
}
