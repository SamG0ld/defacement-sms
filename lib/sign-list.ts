// The sign-generation input contract: turn the app's CSV export (the file
// `/signs/export` produces) into a normalized, size-grouped sign list the
// generators consume. This is the executable form of the column contract the
// Figma skill + the Python fallback read — change it here and both follow.
//
// Pure + dependency-free (mirrors lib/print-summary.ts). Reuses parseCsv for the
// CSV grammar and signTypeFromSize for the size -> template/canvas bucket, so the
// grouping key stays identical to the rest of the app.

import { parseCsv, stripFormulaGuard } from "@/lib/csv";
import { signTypeFromSize } from "@/lib/print-summary";

// Canonical contract field -> accepted header aliases (compared lowercased +
// trimmed). Mirrors the alias spirit of app/(app)/signs/import/_map.ts so a
// slightly reshaped export still parses. Only these five columns matter to a
// generator; every other export column is ignored.
const HEADER_ALIASES = {
  // No bare "id" — it's the canonical export header "Item ID"; a generic "id"
  // alias would mis-bind to any other column literally named id.
  itemId: ["item id", "itemid", "map#", "map #", "map"],
  signText: ["sign text", "signtext", "text", "sign"],
  // Back-face render text for a double-sided board whose faces differ (same art,
  // different words). Optional — only meaningful when doubleSided; a generator draws
  // a second face from it. "" when absent.
  backText: ["back text", "backtext"],
  size: ["size", "material"],
  zone: ["zone", "zone code"],
  // The room / exact destination printed bottom-right on the sign face (DC34).
  // Optional — a generator renders it verbatim only when non-empty.
  room: ["room"],
  // Double-sided flag. The export emits an explicit "Double-Sided" Yes/No column;
  // when present it's authoritative, else we fall back to the size-string heuristic
  // ("...Double..."). Keeps a 4'x8' Double in its own generation batch (two print
  // faces) instead of collapsing into the Single meterboard group.
  doubleSided: ["double-sided", "double sided", "doublesided", "is double sided"],
} as const;

// Cap on data rows. Matches the export route's own MAX_EXPORT_ROWS — a sign list
// can't exceed what the app would export — and bounds a pathological input.
const MAX_SIGN_ROWS = 10_000;

type ContractField = keyof typeof HEADER_ALIASES;

// One sign ready to render. `renderText` is the string the generator draws;
// `template` is the per-size component/canvas it draws into.
export type SignListItem = {
  itemId: string; // for output file naming (SIGN-NNN - NAME); "" if absent
  renderText: string; // Sign Text, trimmed + UPPERCASE — the string to render
  backText: string; // back-face render text, trimmed + UPPERCASE; "" if none (only used when doubleSided)
  size: string; // raw Size string from the export ("" if absent)
  template: string; // signTypeFromSize(size) — the template/canvas bucket
  doubleSided: boolean; // two print faces — splits its own generation batch
  zone: string; // Zone code for grouping/labeling ("" if absent)
  room: string; // Room / exact destination, verbatim — printed bottom-right; "" if absent
};

// Signs sharing one template/canvas AND double-sidedness. Different sizes need
// different templates; single vs double of the same size are distinct print jobs
// (two faces), so a generator builds one component per group.
export type SignSizeGroup = {
  template: string; // canonical form, e.g. '22"x28"' (signTypeFromSize output)
  size: string; // a representative raw size from this group
  doubleSided: boolean; // whether this group's signs print on two faces
  items: SignListItem[];
};

// A data row the parser deliberately did not emit, with why (e.g. blank Sign
// Text) — surfaced so a run can report "kicked back N rows" instead of silently
// dropping them.
export type SkippedRow = {
  line: number; // 1-based source row number (header is line 1)
  reason: string;
};

export type ParsedSignList = {
  items: SignListItem[];
  groups: SignSizeGroup[]; // items bucketed by template, in first-seen order
  skipped: SkippedRow[];
};

// Map header cells -> the column index for each contract field. First matching
// header wins (a duplicate header doesn't clobber the earlier mapping).
function mapContractHeaders(
  header: string[],
): Partial<Record<ContractField, number>> {
  const map: Partial<Record<ContractField, number>> = {};
  header.forEach((raw, idx) => {
    const h = raw.trim().toLowerCase();
    for (const field of Object.keys(HEADER_ALIASES) as ContractField[]) {
      const aliases: readonly string[] = HEADER_ALIASES[field];
      if (map[field] === undefined && aliases.includes(h)) {
        map[field] = idx;
      }
    }
  });
  return map;
}

// stripFormulaGuard (lib/csv.ts) undoes the export's formula guard so the quote
// never renders on the sign face. Imported, not re-implemented — a local copy is
// how it drifted out of step with the export guard before (#202).
const at = (row: string[], idx: number | undefined): string =>
  idx === undefined ? "" : stripFormulaGuard((row[idx] ?? "").trim());

// Double-sided: an explicit column value wins (Yes/Y/true/1/x/✓), else fall back to
// the size-string heuristic ("...Double..."). Mirrors the import parser's rule
// (app/(app)/signs/import/_map.ts parseDoubleSided) so the two agree.
const DOUBLE_TRUTHY = new Set(["y", "yes", "true", "x", "1", "✓"]);
function parseDoubleSided(cell: string, size: string): boolean {
  if (cell) return DOUBLE_TRUTHY.has(cell.toLowerCase());
  return /double/i.test(size); // identical to import's parseDoubleSided fallback
}

// Parse the app's sign export CSV into a render-ready, size-grouped list.
//
// Contract:
//  - `Sign Text` is REQUIRED (the render string). A missing header throws — the
//    file isn't a sign export and silently producing zero signs would be worse.
//  - `Item ID` / `Size` / `Zone` / `Room` are optional (default to "" / "Sign"
//    template).
//  - Each sign renders `Sign Text` alone, uppercased; `Item ID` is for file
//    naming only and never part of the rendered text. `Room` (when present) is
//    the verbatim string a generator prints bottom-right.
export function parseSignListCsv(csvText: string): ParsedSignList {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new Error("Sign export is empty — no header row found.");
  }

  const map = mapContractHeaders(rows[0]);
  if (map.signText === undefined) {
    throw new Error(
      'Sign export is missing the required "Sign Text" column — not a sign list.',
    );
  }
  if (rows.length - 1 > MAX_SIGN_ROWS) {
    throw new Error(
      `Sign export has too many rows (${rows.length - 1}); max ${MAX_SIGN_ROWS}.`,
    );
  }

  const items: SignListItem[] = [];
  const skipped: SkippedRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1; // 1-based, header is line 1
    if (row.every((c) => (c ?? "").trim() === "")) continue; // skip blank rows

    const signText = at(row, map.signText);
    if (!signText) {
      skipped.push({ line, reason: "blank Sign Text" });
      continue;
    }

    const size = at(row, map.size);
    const backText = at(row, map.backText);
    items.push({
      itemId: at(row, map.itemId),
      renderText: signText.toUpperCase(),
      backText: backText ? backText.toUpperCase() : "",
      size,
      template: signTypeFromSize(size),
      doubleSided: parseDoubleSided(at(row, map.doubleSided), size),
      zone: at(row, map.zone),
      room: at(row, map.room),
    });
  }

  return { items, groups: groupByTemplate(items), skipped };
}

// Bucket items by their template (size group) AND double-sidedness, preserving
// first-seen order so a generated batch is stable and reviewable. Single vs double
// of the same template split into separate groups (a double is two print faces), so
// a 4'x8' Double is never folded into the Single meterboard batch. signTypeFromSize
// emits a fixed, finite set of templates, so a "<template> <bool>" key can't collide
// (no template ends in " true"/" false").
function groupByTemplate(items: SignListItem[]): SignSizeGroup[] {
  const groups: SignSizeGroup[] = [];
  const byKey = new Map<string, SignSizeGroup>();
  for (const item of items) {
    const key = `${item.template} ${item.doubleSided}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        template: item.template,
        size: item.size,
        doubleSided: item.doubleSided,
        items: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
