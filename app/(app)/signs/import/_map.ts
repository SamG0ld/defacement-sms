// Column mapping + validation shared by all CSV import sources. Pure +
// server-safe; the generic parser lives here, source-specific parsers
// (signSheet / master) live in ./_parsers and reuse these helpers.
import { z } from "zod";

import { stripFormulaGuard } from "@/lib/csv";
import { categoryFromSize, signTypeFromSize } from "@/lib/print-summary";
import { normalizeRoomCode } from "@/lib/room-code";
import type { SignCategory } from "@/app/generated/prisma/enums";
import { DEPLOYMENT_SLOTS } from "../_lib";

// The DB-dedup key, shared by the preview (categorizeRows) and the DB snapshot
// (import actions' loadContext) so the two can never drift. The room code is
// normalized (normalizeRoomCode) so a variant spelling of the same booth
// ("W204, W205" vs "W204-W205") dedupes instead of creating a twin; signText + size
// still keep a room's distinct physical signs (a sock vs a meterboard) apart.
export function signDedupKey(
  itemId: string,
  signText: string,
  size: string,
): string {
  // JSON tuple, not a space-join: collision-proof (a space-joined key can realign at
  // field boundaries, e.g. text "A", size "B C" vs text "A B", size "C").
  return JSON.stringify([normalizeRoomCode(itemId), signText, size]);
}

// The DB's master-sheet identity — the columns of the partial unique index added
// in migration 20260724120000. DIFFERENT from signDedupKey: this one ignores
// signText and size and keys on sheetName + category instead, which is why a row
// can look like a fresh re-add by dedup key while still colliding in Postgres
// (the master sheet can override a space's printed text without changing its
// Name). Used to keep an auto-importing `readd` from hard-failing the whole
// transaction on a live twin. (#265)
export function sheetIdentityKey(
  itemId: string,
  sheetName: string,
  category: string,
): string {
  return JSON.stringify([itemId, sheetName, category]);
}

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
  // No bare "id": the canonical export header is "Item ID". A generic "id" alias
  // would mis-bind to any column literally named id and isn't recognized by the
  // generator parser (lib/sign-list.ts) or the Python config — keep all three in
  // step so a CSV round-trips consistently across import + generation.
  itemId: ["item id", "itemid", "map#", "map #", "map"],
  signText: ["sign text", "signtext", "text", "sign"],
  // Back-face text for a double-sided board whose faces differ. Round-trips from the
  // export "Back Text" column back onto Sign.backText.
  backText: ["back text", "backtext"],
  signType: ["type", "sign type", "signtype"],
  size: ["size", "material"],
  quantity: ["qty", "quantity", "print qty", "count"],
  doubleSided: ["double-sided", "double sided", "doublesided", "is double sided"],
  placementArea: ["location", "placement", "placement area", "area"],
  // The room / exact destination printed bottom-right on the sign face (DC34).
  // The export emits "Room"; round-trips back onto Sign.exactDestination.
  exactDestination: ["room", "room number", "exact destination"],
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
  existingKeys: Set<string>; // dedup key held by a LIVE (non-archived) sign
  // Dedup keys held ONLY by soft-removed (`archived`) tombstones — no live row
  // shares them. Re-importing one of these is a RE-ADD, not a duplicate: #263
  // made "tombstone + live twin" the intended end state of remove-then-re-add and
  // the DB permits it (the partial unique index excludes `archived`). Kept
  // separate from existingKeys so the preview can say which one it is. (#265)
  archivedKeys: Set<string>;
  // sheetIdentityKey values held by LIVE rows the DB's partial unique index
  // covers (real, non-archived, sheetName set). A `readd` imports without the
  // duplicate opt-in, so it has to be checked against the index's OWN identity as
  // well as the dedup key — otherwise a re-add that Postgres will reject takes
  // the entire import transaction down with it, where the old `duplicate`
  // labelling would merely have skipped the row. (#265)
  liveSheetIdentities: Set<string>;
};

// The import allowlist: only these scalar fields can be written from any import
// source. executeImport spreads this then hardcodes status/isTestData -- sources
// control values, never keys, so widening requires a deliberate edit here.
export type SignData = {
  itemId: string;
  signText: string;
  // Back-face text for a double-sided board whose faces differ (same art, different
  // words). Optional — only the generic CSV import sets it; other sources leave it
  // undefined (→ null). Round-trips with the export "Back Text" column.
  backText?: string | null;
  // The master sheet's Name (stable identifier), when the source is the master
  // sheet. signText is the printed text (may be a "text should be X" override);
  // sheetName is what reconcile matches on. Other sources leave it null.
  sheetName: string | null;
  signType: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  category: SignCategory;
  printable: boolean;
  placementArea: string | null;
  // Room / exact destination — the verbatim string the sign art prints
  // bottom-right (DC34). Round-trips with the export "Room" column.
  exactDestination: string | null;
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

// `readd` is a first-class outcome, not a flavour of duplicate: the row matches
// only a removed tombstone, so it imports as a new sign WITHOUT the
// likely-duplicate opt-in. Labelling it "duplicate" is what made a lead decline
// the opt-in and silently lose the re-add. (#265)
export type MappedRow = RowDraft & {
  status: "valid" | "invalid" | "duplicate" | "readd";
  reason?: string;
};

export const rowSchema = z.object({
  itemId: z.string().min(1, "missing item ID").max(100),
  signText: z.string().min(1, "missing sign text").max(500),
  backText: z.string().max(500).nullable().optional(),
  sheetName: z.string().max(500).nullable(),
  signType: z.string().min(1).max(100),
  size: z.string().min(1).max(50),
  quantity: z.number().int().min(1).max(999),
  doubleSided: z.boolean(),
  needsEasel: z.boolean(),
  category: z.enum(SIGN_CATEGORY_VALUES),
  printable: z.boolean(),
  placementArea: z.string().max(300).nullable(),
  exactDestination: z.string().max(300).nullable(),
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
  counts: {
    valid: number;
    invalid: number;
    duplicate: number;
    readd: number;
    total: number;
  };
  // Non-fatal, sheet-level notices surfaced in the preview (e.g. a whole section
  // intentionally skipped). Never silently drop — say what wasn't imported.
  notices?: string[];
};

// stripFormulaGuard (lib/csv.ts) is the inverse of the export's formula guard: it
// takes the guard quote back off so a round-tripped value (e.g. a signText like
// "+1 BADGE PICKUP") never keeps it. Imported rather than re-implemented — this used
// to be a local copy, and it drifted out of step with the export guard (#202).
// "'24 reunion" (apostrophe then a digit) is never guarded, so it stays untouched.
export const cell = (row: string[], idx: number | undefined): string =>
  idx === undefined ? "" : stripFormulaGuard((row[idx] ?? "").trim());

function emptyPreview(headerError: string): ImportPreview {
  return {
    headerError,
    mappedColumns: [],
    ignoredHeaders: [],
    rows: [],
    counts: { valid: 0, invalid: 0, duplicate: 0, readd: 0, total: 0 },
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
    // Dedup on normRoomCode(itemId) + signText + size: the same room can legitimately
    // get both a sock (room-label cover) and a meterboard, or a poster and a schedule
    // — distinct physical signs that share a Map# and text but differ by size. Keying
    // on size keeps them; a true re-import (or a variant room-code spelling) dedupes.
    const key = signDedupKey(
      draft.data.itemId,
      draft.data.signText,
      draft.data.size,
    );
    // Precedence matters. A live row (or an earlier row in THIS file) makes it a
    // real duplicate; only when the sole match is a removed tombstone is it a
    // re-add, which imports without the opt-in. Checking live first is what keeps
    // a sign that was removed, re-added, and is now live from being mislabelled.
    const matchedLive = ctx.existingKeys.has(key) || seenInFile.has(key);
    const matchedTombstone = !matchedLive && ctx.archivedKeys.has(key);
    // A re-add auto-imports, so it alone is also checked against the DB's OWN
    // identity: if a live row already holds this (itemId, sheetName, category),
    // Postgres' partial unique index rejects the insert — and because the insert
    // is ONE transaction, it takes the whole import down. Demote it back to
    // `duplicate`, which is what it was before re-adds existed: skipped by
    // default, still reachable through the opt-in. (Reachable when the sheet
    // overrode a space's printed text — the tombstone keeps the old text so the
    // dedup key still matches it, while the live twin holds the same identity.)
    // Deliberately scoped to re-adds: a `valid` row that would collide is
    // pre-existing behaviour and still surfaces through executeImport's P2002.
    const identityTaken =
      matchedTombstone &&
      draft.data.sheetName !== null &&
      ctx.liveSheetIdentities.has(
        sheetIdentityKey(
          draft.data.itemId,
          draft.data.sheetName,
          draft.data.category,
        ),
      );
    const isReadd = matchedTombstone && !identityTaken;
    const isDup = matchedLive || identityTaken;
    seenInFile.add(key);
    out.push({
      ...draft,
      status: isDup ? "duplicate" : isReadd ? "readd" : "valid",
      reason: identityTaken
        ? "a sign with this room, sheet name and item type is still in the record"
        : isDup
          ? "matches an existing sign"
          : isReadd
            ? "re-add of a sign that was removed from the record"
            : undefined,
    });
  }

  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  let readd = 0;
  for (const r of out) {
    if (r.status === "valid") valid += 1;
    else if (r.status === "invalid") invalid += 1;
    else if (r.status === "readd") readd += 1;
    else duplicate += 1;
  }

  return {
    headerError: null,
    mappedColumns: meta.mappedColumns,
    ignoredHeaders: meta.ignoredHeaders,
    rows: out,
    counts: { valid, invalid, duplicate, readd, total: out.length },
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

// Double-sided flag. The export emits an explicit "Double-Sided" Yes/No column;
// when present (non-empty) it is authoritative and round-trips exactly. Falls
// back to the size-string heuristic ("...Double...") only when the column is
// absent — older/hand-made sheets that encode it in the size (e.g. "4'x8' Double").
export function parseDoubleSided(raw: string, sizeRaw: string): boolean {
  if (raw) return isTruthy(raw);
  return /double/i.test(sizeRaw);
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

// Hyphen-insensitive match key. Seeded tag slugs are mostly slugify(name), but a
// few collapse spaces instead of hyphenating (e.g. "Meter Board" -> "meterboard",
// not "meter-board"). The app's own CSV export already emits stored slugs, so an
// app-exported file round-trips exactly (see lib/sign-export.ts and the #98
// regression test). This fallback covers HAND-AUTHORED / generic CSVs, where a
// person types a tag's display name ("Meter Board") in the Tags cell: that
// slugifies to "meter-board", which would otherwise never hit the stored
// "meterboard" slug. Comparing on this key lets such a display name resolve.
function tagMatchKey(slug: string): string {
  return slug.replace(/-/g, "");
}

// Resolve slugs against known tags; unknowns become a warning (not an error).
// An exact slug match always wins; otherwise we fall back to a hyphen-insensitive
// match and emit the canonical stored slug so the row inserts against a real tag.
export function resolveTagSlugs(
  slugs: string[],
  ctx: MappingContext,
  warnings: string[],
): string[] {
  // key -> canonical stored slug, for the hyphen-insensitive fallback. First-wins
  // on a key collision, matching Set iteration order — which is DB-scan order and
  // not deterministic, so stored slugs must stay collision-free on the dehyphenated
  // key (they are today; all seeded keys are unique).
  const byKey = new Map<string, string>();
  for (const stored of ctx.tagSlugs) {
    const key = tagMatchKey(stored);
    if (!byKey.has(key)) byKey.set(key, stored);
  }

  const out: string[] = [];
  for (const slug of slugs) {
    if (!slug) continue;
    if (ctx.tagSlugs.has(slug)) {
      out.push(slug);
      continue;
    }
    const canonical = byKey.get(tagMatchKey(slug));
    if (canonical !== undefined) out.push(canonical);
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
      backText: cell(row, map.backText) || null,
      sheetName: null, // generic CSV import is not the master sheet
      signType: cell(row, map.signType) || signTypeFromSize(sizeRaw),
      size: sizeRaw || "Unspecified",
      quantity: clampQuantity(cell(row, map.quantity)),
      doubleSided: parseDoubleSided(cell(row, map.doubleSided), sizeRaw),
      needsEasel: isTruthy(cell(row, map.needsEasel)),
      category: categoryFromSize(sizeRaw),
      printable: true,
      placementArea: cell(row, map.placementArea) || null,
      exactDestination: cell(row, map.exactDestination) || null,
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
