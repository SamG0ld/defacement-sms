import type { MappingContext } from "@/app/(app)/signs/import/_map";
import { MASTER_SHEET_TAG } from "@/lib/tags";

// Build a MappingContext for parser tests without a DB. Zone codes are upper-cased
// to match how the parsers look them up (ctx.zoneByCode.get(code.toUpperCase())).
// The `master-sheet` system tag is always present (it's seeded in every real DB and
// the master parser assigns it to every row), so parser tests don't need to list it.
export function makeCtx(
  opts: {
    zones?: Record<string, number>;
    tagSlugs?: string[];
    existingKeys?: string[];
    // Keys held ONLY by soft-removed tombstones — a match here is a re-add, not a
    // duplicate (#265).
    archivedKeys?: string[];
    // sheetIdentityKey values held by live rows the DB's partial unique index
    // covers; a re-add that hits one is demoted back to duplicate (#265).
    liveSheetIdentities?: string[];
  } = {},
): MappingContext {
  const zoneByCode = new Map<string, number>();
  for (const [code, id] of Object.entries(opts.zones ?? {})) {
    zoneByCode.set(code.toUpperCase(), id);
  }
  return {
    zoneByCode,
    tagSlugs: new Set([MASTER_SHEET_TAG, ...(opts.tagSlugs ?? [])]),
    existingKeys: new Set(opts.existingKeys ?? []),
    archivedKeys: new Set(opts.archivedKeys ?? []),
    liveSheetIdentities: new Set(opts.liveSheetIdentities ?? []),
  };
}
