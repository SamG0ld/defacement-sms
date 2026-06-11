import type { DeploySignView } from "@/lib/deploy/contract";

// Quick floor search: match a sign by item ID or sign text. Pure and synchronous
// so it runs instantly over the already-bootstrapped in-memory sign set — works
// offline, no network. Mirrors the /signs server search (itemId + signText),
// minus placementArea which the deploy projection doesn't carry.

type SearchableSign = Pick<DeploySignView, "itemId" | "signText">;

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// Match against an already-normalized (trimmed + lowercased) query. Empty `q`
// matches all. Kept private so callers don't pay to re-normalize per sign.
function matchesNormalized(sign: SearchableSign, q: string): boolean {
  if (!q) return true;
  return (
    sign.itemId.toLowerCase().includes(q) ||
    sign.signText.toLowerCase().includes(q)
  );
}

// Returns true when `query` is empty (match-all) or `sign` contains the query
// as a case-insensitive substring of its item ID or sign text.
export function signMatchesQuery(sign: SearchableSign, query: string): boolean {
  return matchesNormalized(sign, normalizeQuery(query));
}

export function filterSignsByQuery<T extends SearchableSign>(
  signs: readonly T[],
  query: string,
): T[] {
  const q = normalizeQuery(query);
  if (!q) return [...signs];
  return signs.filter((s) => matchesNormalized(s, q));
}
