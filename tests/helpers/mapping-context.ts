import type { MappingContext } from "@/app/(app)/signs/import/_map";

// Build a MappingContext for parser tests without a DB. Zone codes are upper-cased
// to match how the parsers look them up (ctx.zoneByCode.get(code.toUpperCase())).
export function makeCtx(
  opts: {
    zones?: Record<string, number>;
    tagSlugs?: string[];
    existingKeys?: string[];
  } = {},
): MappingContext {
  const zoneByCode = new Map<string, number>();
  for (const [code, id] of Object.entries(opts.zones ?? {})) {
    zoneByCode.set(code.toUpperCase(), id);
  }
  return {
    zoneByCode,
    tagSlugs: new Set(opts.tagSlugs ?? []),
    existingKeys: new Set(opts.existingKeys ?? []),
  };
}
