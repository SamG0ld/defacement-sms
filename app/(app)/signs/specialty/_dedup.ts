// Soft duplicate detection for specialty intake (advisory only — never blocks a
// write). The hard dedup key is signDedupKey (app/(app)/signs/import/_map.ts),
// shared by the CSV importer and specialty intake: a JSON tuple of
// [normalizeRoomCode(itemId), signText, size]. So a straight "Duplicate" row —
// which is handed a fresh EXT itemId — always classifies VALID even though it's a
// copy. This helper flags the softer "same text + size as another row / an existing
// sign" case so the reviewer notices, without ever changing a row's status.

// Normalized identity for the soft check: text + size, trimmed and lower-cased.
// Looser than the hard dupKey on purpose (catches human casing/spacing drift),
// and itemId is deliberately excluded — that's the whole point of the hint.
export function softDupKey(signText: string, size: string): string {
  return `${signText.trim().toLowerCase()} | ${size.trim().toLowerCase()}`;
}

export type SoftDupInput = { signText: string; size: string };

// For each row, return an advisory hint string (or null). A row is hinted when
// its text+size matches an earlier row in the same batch or a sign already in
// the DB. Rows missing text or size are never hinted (nothing to match on yet).
export function detectSoftDuplicates(
  rows: readonly SoftDupInput[],
  existingKeys: ReadonlySet<string>,
): (string | null)[] {
  const firstSeenAt = new Map<string, number>();
  return rows.map((row, i) => {
    const hasBoth = row.signText.trim() !== "" && row.size.trim() !== "";
    const key = softDupKey(row.signText, row.size);
    if (!hasBoth) return null;

    const earlier = firstSeenAt.get(key);
    if (earlier !== undefined) {
      return `possible duplicate — same text + size as row ${earlier + 1}`;
    }
    firstSeenAt.set(key, i);
    if (existingKeys.has(key)) {
      return "possible duplicate — same text + size as an existing sign";
    }
    return null;
  });
}
