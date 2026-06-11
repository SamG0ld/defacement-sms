// The sign-generation input contract: turn the app's CSV export (the file
// `/signs/export` produces) into a normalized, size-grouped sign list the
// generators consume. This is the executable form of the column contract the
// Figma skill + the Python fallback read — change it here and both follow.
//
// Pure + dependency-free (mirrors lib/print-summary.ts). Reuses parseCsv for the
// CSV grammar and signTypeFromSize for the size -> template/canvas bucket, so the
// grouping key stays identical to the rest of the app.

import { parseCsv } from "@/lib/csv";
import { signTypeFromSize } from "@/lib/print-summary";

// Canonical contract field -> accepted header aliases (compared lowercased +
// trimmed). Mirrors the alias spirit of app/(app)/signs/import/_map.ts so a
// slightly reshaped export still parses. Only these four columns matter to a
// generator; every other export column is ignored.
const HEADER_ALIASES = {
  // No bare "id" — it's the canonical export header "Item ID"; a generic "id"
  // alias would mis-bind to any other column literally named id.
  itemId: ["item id", "itemid", "map#", "map #", "map"],
  signText: ["sign text", "signtext", "text", "sign"],
  size: ["size", "material"],
  zone: ["zone", "zone code"],
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
  size: string; // raw Size string from the export ("" if absent)
  template: string; // signTypeFromSize(size) — the template/canvas bucket
  zone: string; // Zone code for grouping/labeling ("" if absent)
};

// Signs sharing one template/canvas. Different sizes need different templates,
// so a generator builds one component per group.
export type SignSizeGroup = {
  template: string; // canonical form, e.g. '22"x28"' (signTypeFromSize output)
  size: string; // a representative raw size from this group
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

// Inverse of lib/csv.ts neutralizeFormula: the export prefixes a single quote to
// cells that begin with a formula char (= + - @ tab CR) so a spreadsheet won't
// execute them. Strip it back off so it never renders on the sign face.
function stripFormulaGuard(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

const at = (row: string[], idx: number | undefined): string =>
  idx === undefined ? "" : stripFormulaGuard((row[idx] ?? "").trim());

// Parse the app's sign export CSV into a render-ready, size-grouped list.
//
// Contract:
//  - `Sign Text` is REQUIRED (the render string). A missing header throws — the
//    file isn't a sign export and silently producing zero signs would be worse.
//  - `Item ID` / `Size` / `Zone` are optional (default to "" / "Sign" template).
//  - Each sign renders `Sign Text` alone, uppercased; `Item ID` is for file
//    naming only and never part of the rendered text.
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
    items.push({
      itemId: at(row, map.itemId),
      renderText: signText.toUpperCase(),
      size,
      template: signTypeFromSize(size),
      zone: at(row, map.zone),
    });
  }

  return { items, groups: groupByTemplate(items), skipped };
}

// Bucket items by their template (size group), preserving first-seen order so a
// generated batch is stable and reviewable.
function groupByTemplate(items: SignListItem[]): SignSizeGroup[] {
  const groups: SignSizeGroup[] = [];
  const byTemplate = new Map<string, SignSizeGroup>();
  for (const item of items) {
    let group = byTemplate.get(item.template);
    if (!group) {
      group = { template: item.template, size: item.size, items: [] };
      byTemplate.set(item.template, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
