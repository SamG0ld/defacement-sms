// Column mapping + validation shared by all CSV import sources. Pure +
// server-safe; the generic parser lives here, source-specific parsers
// (signSheet / master) live in ./_parsers and reuse these helpers.
import { z } from "zod";

import { categoryFromSize, signTypeFromSize } from "@/lib/print-summary";
import type { SignCategory } from "@/app/generated/prisma/enums";
import { DEPLOYMENT_SLOTS } from "../_lib";

// Item-class enum values, kept in sync with prisma SignCategory. Used by the import
// row validator. (zod v4 z.enum takes a literal tuple; this is the single source.)
const SIGN_CATEGORY_VALUES = [
  "easel_sign",
  "meterboard",
  "socks",
  "ops_map",
  "union_installed",
  "other",
] as const satisfies readonly SignCategory[];

// Canonical field -> accepted header aliases (compared lowercased + trimmed).
// itemId and signText are the only truly required columns; everything else has
// a sensible default so a slightly different sheet still imports.
const HEADER_ALIASES: Record<string, string[]> = {
  itemId: ["item id", "itemid", "map#", "map #", "map", "id"],
  signText: ["sign text", "signtext", "text", "sign"],
  signType: ["type", "sign type", "signtype"],
  size: ["size", "material"],
  quantity: ["qty", "quantity", "print qty", "count"],
  placementArea: ["location", "placement", "placement area", "area"],
  needsEasel: ["easel", "needs easel", "easel y/n", "easel?"],
  zone: ["zone", "zone code"],
  tags: ["tags", "tag", "section", "category"],
  deploymentSlot: ["deploy slot", "deployment slot", "slot", "deploy"],
  notes: ["notes", "note", "comments"],
};

const SLOT_VALUES = new Set(DEPLOYMENT_SLOTS.map((s) => s.value));
const TRUTHY = new Set(["y", "yes", "true", "x", "1", "✓"]);

// Inverted alias lookup, hoisted once — mapHeaders scans this per header cell.
// First-wins on a duplicated alias, matching HEADER_ALIASES declaration order.
const ALIAS_TO_FIELD = new Map<string, string>();
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const alias of aliases) {
    if (!ALIAS_TO_FIELD.has(alias)) ALIAS_TO_FIELD.set(alias, field);
  }
}

// Hard cap on data rows per import. Comfortably above the real DC sheet (~390)
// while preventing a multi-million-row file from exhausting memory / saturating
// the DB through the per-row insert loop in executeImport.
export const MAX_IMPORT_ROWS = 2000;

export type ColumnMap = Partial<Record<keyof typeof HEADER_ALIASES, number>>;

export function mapHeaders(headerRow: string[]): ColumnMap {
  const map: ColumnMap = {};
  headerRow.forEach((raw, idx) => {
    const field = ALIAS_TO_FIELD.get(raw.trim().toLowerCase()) as
      | keyof ColumnMap
      | undefined;
    if (field !== undefined && map[field] === undefined) {
      map[field] = idx;
    }
  });
  return map;
}

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Normalize loose slot text (e.g. "Weds AM", "THURS_PM") to a DEPLOYMENT_SLOTS
// value, or null if it doesn't resolve.
export function normalizeSlot(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/\s+/g, "_");
  if (!s) return null;
  s = s
    .replace(/^WEDS(_|$)/, "WED$1")
    .replace(/^THURS(_|$)/, "THU$1")
    .replace(/^TUE(_|$)/, "TUES$1");
  return SLOT_VALUES.has(s) ? s : null;
}

export type MappingContext = {
  zoneByCode: Map<string, number>; // upper(zoneCode) -> id
  tagSlugs: Set<string>;
  existingKeys: Set<string>; // `${itemId} ${signText} ${size}` already in DB
};

// The import allowlist: only these scalar fields can be written from any import
// source. executeImport spreads this then hardcodes status/isTestData -- sources
// control values, never keys, so widening requires a deliberate edit here.
export type SignData = {
  itemId: string;
  signText: string;
  signType: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  category: SignCategory;
  printable: boolean;
  placementArea: string | null;
  notes: string | null;
  deploymentSlot: string | null;
  zoneId: number | null;
  eventStart?: Date | null;
  eventEnd?: Date | null;
  deployByDate?: Date | null;
};

// A mapped-but-not-yet-categorized row. Every source parser produces these,
// then hands them to categorizeRows.
export type RowDraft = {
  line: number; // 1-based source row number
  data: SignData;
  tagSlugs: string[];
  warnings: string[];
};

export type MappedRow = RowDraft & {
  status: "valid" | "invalid" | "duplicate";
  reason?: string;
};

export const rowSchema = z.object({
  itemId: z.string().min(1, "missing item ID").max(100),
  signText: z.string().min(1, "missing sign text").max(500),
  signType: z.string().min(1).max(100),
  size: z.string().min(1).max(50),
  quantity: z.number().int().min(1).max(999),
  doubleSided: z.boolean(),
  needsEasel: z.boolean(),
  category: z.enum(SIGN_CATEGORY_VALUES),
  printable: z.boolean(),
  placementArea: z.string().max(300).nullable(),
  notes: z.string().max(5000).nullable(),
  deploymentSlot: z.string().max(50).nullable(),
  zoneId: z.number().int().positive().nullable(),
  eventStart: z.date().nullable().optional(),
  eventEnd: z.date().nullable().optional(),
  deployByDate: z.date().nullable().optional(),
});

export type ImportPreview = {
  headerError: string | null;
  mappedColumns: string[]; // canonical fields detected
  ignoredHeaders: string[]; // header cells that didn't map
  rows: MappedRow[];
  counts: { valid: number; invalid: number; duplicate: number; total: number };
  // Non-fatal, sheet-level notices surfaced in the preview (e.g. a whole section
  // intentionally skipped). Never silently drop — say what wasn't imported.
  notices?: string[];
};

export const cell = (row: string[], idx: number | undefined): string =>
  idx === undefined ? "" : (row[idx] ?? "").trim();

function emptyPreview(headerError: string): ImportPreview {
  return {
    headerError,
    mappedColumns: [],
    ignoredHeaders: [],
    rows: [],
    counts: { valid: 0, invalid: 0, duplicate: 0, total: 0 },
  };
}

export function tooManyRows(rowCount: number): ImportPreview | null {
  if (rowCount > MAX_IMPORT_ROWS) {
    return emptyPreview(
      `Too many rows (${rowCount}); max ${MAX_IMPORT_ROWS}. Split the file and import in parts.`,
    );
  }
  return null;
}

// Shared finalizer for ALL import sources: validate each draft, then mark
// valid / invalid / duplicate (deduped against the DB AND within the file).
export function categorizeRows(
  drafts: RowDraft[],
  ctx: MappingContext,
  meta: { mappedColumns: string[]; ignoredHeaders: string[]; notices?: string[] },
): ImportPreview {
  const seenInFile = new Set<string>();
  const out: MappedRow[] = [];

  for (const draft of drafts) {
    const parsed = rowSchema.safeParse(draft.data);
    if (!parsed.success) {
      out.push({
        ...draft,
        status: "invalid",
        reason: parsed.error.issues[0]?.message ?? "invalid row",
      });
      continue;
    }
    // Dedup on itemId + signText + size: the same room can legitimately get
    // both a sock (room-label cover) and a meterboard, or a poster and a
    // schedule — distinct physical signs that share a Map# and text but differ
    // by size. Keying on size keeps them; a true re-import still dedupes.
    const key = `${draft.data.itemId} ${draft.data.signText} ${draft.data.size}`;
    const isDup = ctx.existingKeys.has(key) || seenInFile.has(key);
    seenInFile.add(key);
    out.push({
      ...draft,
      status: isDup ? "duplicate" : "valid",
      reason: isDup ? "matches an existing sign" : undefined,
    });
  }

  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  for (const r of out) {
    if (r.status === "valid") valid += 1;
    else if (r.status === "invalid") invalid += 1;
    else duplicate += 1;
  }

  return {
    headerError: null,
    mappedColumns: meta.mappedColumns,
    ignoredHeaders: meta.ignoredHeaders,
    rows: out,
    counts: { valid, invalid, duplicate, total: out.length },
    notices: meta.notices,
  };
}

// ----- Field helpers reused by the source-specific parsers -----

export function clampQuantity(raw: string): number {
  const n = parseInt(raw || "1", 10);
  // Clamp so an out-of-range qty is a quiet coercion, not a cryptic "invalid".
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : 1;
}

export function isTruthy(raw: string): boolean {
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function resolveZone(
  code: string,
  ctx: MappingContext,
  warnings: string[],
): number | null {
  if (!code) return null;
  const id = ctx.zoneByCode.get(code.toUpperCase());
  if (id === undefined) {
    warnings.push(`unknown zone "${code}"`);
    return null;
  }
  return id;
}

// Resolve slugs against known tags; unknowns become a warning (not an error).
export function resolveTagSlugs(
  slugs: string[],
  ctx: MappingContext,
  warnings: string[],
): string[] {
  const out: string[] = [];
  for (const slug of slugs) {
    if (!slug) continue;
    if (ctx.tagSlugs.has(slug)) out.push(slug);
    else warnings.push(`unknown tag "${slug}"`);
  }
  return out;
}

// Split a free-text tag cell (comma/semicolon) -> slugs that exist.
export function resolveTags(
  rawTags: string,
  ctx: MappingContext,
  warnings: string[],
): string[] {
  if (!rawTags) return [];
  return resolveTagSlugs(
    rawTags.split(/[;,]/).map((p) => slugify(p)),
    ctx,
    warnings,
  );
}

// ----- Generic column-mapped parser (the "Generic CSV" source) -----

export function buildPreview(
  rows: string[][],
  ctx: MappingContext,
): ImportPreview {
  if (rows.length === 0) return emptyPreview("The file is empty.");
  const capped = tooManyRows(rows.length - 1);
  if (capped) return capped;

  const header = rows[0];
  const map = mapHeaders(header);
  const missing: string[] = [];
  if (map.itemId === undefined) missing.push("Item ID / Map#");
  if (map.signText === undefined) missing.push("Sign Text");

  const mappedIdx = new Set(Object.values(map));
  const ignoredHeaders = header
    .filter((_, i) => !mappedIdx.has(i))
    .map((h) => h.trim())
    .filter(Boolean);
  const mappedColumns = Object.keys(map);

  if (missing.length > 0) {
    return {
      ...emptyPreview(`Missing required column(s): ${missing.join(", ")}.`),
      mappedColumns,
      ignoredHeaders,
    };
  }

  const drafts: RowDraft[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => (c ?? "").trim() === "")) continue; // skip blanks

    const warnings: string[] = [];
    const sizeRaw = cell(row, map.size);
    const data: SignData = {
      itemId: cell(row, map.itemId),
      signText: cell(row, map.signText),
      signType: cell(row, map.signType) || signTypeFromSize(sizeRaw),
      size: sizeRaw || "Unspecified",
      quantity: clampQuantity(cell(row, map.quantity)),
      doubleSided: /double/i.test(sizeRaw),
      needsEasel: isTruthy(cell(row, map.needsEasel)),
      category: categoryFromSize(sizeRaw),
      printable: true,
      placementArea: cell(row, map.placementArea) || null,
      notes: cell(row, map.notes) || null,
      deploymentSlot: (() => {
        const raw = cell(row, map.deploymentSlot);
        if (!raw) return null;
        const slot = normalizeSlot(raw);
        if (!slot) warnings.push(`unrecognized slot "${raw}"`);
        return slot;
      })(),
      zoneId: resolveZone(cell(row, map.zone), ctx, warnings),
    };

    const tagSlugs = resolveTags(cell(row, map.tags), ctx, warnings);
    drafts.push({ line: r + 1, data, tagSlugs, warnings });
  }

  return categorizeRows(drafts, ctx, { mappedColumns, ignoredHeaders });
}
