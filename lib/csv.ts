// Dependency-free CSV parse/serialize (RFC 4180-ish). Handles quoted fields,
// embedded commas/newlines, "" escapes, a leading UTF-8 BOM, and CRLF or LF
// line endings. We avoid a parser dependency on purpose (CSV-only import).

export function parseCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if Excel/Sheets added one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // RFC 4180 (what Excel/Sheets emit) only treats a `"` as field quoting when it
  // opens the field. A quote further in is literal data — and the app's own size
  // vocabulary is inch marks (22"x28", 24"x36"), so a hand-edited or non-Excel CSV
  // carries them routinely. Reading those as quoting used to swallow the rest of the
  // row — and, across an embedded newline, the whole row after it — into one field.
  let atFieldStart = true;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // Take the whole run up to the closing quote in one slice instead of a
      // per-character append.
      const close = text.indexOf('"', i);
      const end = close === -1 ? text.length : close;
      field += text.slice(i, end);
      i = end;
      continue;
    }

    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    if (c === "\r") {
      // CRLF: let the following \n do the row break. Lone CR (classic-Mac
      // line ending): treat it as a terminator itself.
      if (text[i + 1] === "\n") {
        i++;
        continue;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    // Plain run: extend to the next delimiter in one slice. `"` is deliberately NOT
    // a break char here — everything from `i` on is mid-field, so a quote in the run
    // is literal text. Starting at i + 1 is safe because the guards above already
    // excluded every delimiter as `c` — keep that invariant if adding branches above.
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "," || ch === "\r" || ch === "\n") break;
      j++;
    }
    field += text.slice(i, j);
    atFieldStart = false;
    i = j;
  }

  // Flush a trailing field/row when the file doesn't end in a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Spreadsheet formula-injection guard. Excel/Sheets treat a cell beginning with
// any of these as a formula, so a stored value like `=cmd|'/c calc'!A0` or
// `=HYPERLINK(...)` would execute when someone opens the exported file. Prefix a
// single quote to force the cell to be read as text. Applied only on serialize
// (export) — parseCsv stays faithful so re-imports aren't corrupted.
//
// The leading-quote RUN in the pattern is what makes the guard REVERSIBLE: a value
// that already starts with apostrophes then a formula char (`'=SUM`, the user's own
// apostrophe) is indistinguishable from a guarded `=SUM` once written, so it earns
// its own guard quote too. stripFormulaGuard then takes exactly one back off and the
// round-trip is lossless. Values like `'24 reunion` (apostrophe, then a non-formula
// char) are never guarded and never stripped.
function neutralizeFormula(s: string): string {
  return /^'*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// Inverse of neutralizeFormula — strip the guard quote back off on import so it
// never lands in the DB or renders on a sign face. Lives here, beside the guard it
// undoes: the two only stay correct if they move together, and keeping separate
// copies in the importers is exactly how they drifted apart before.
export function stripFormulaGuard(s: string): string {
  return /^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Order is load-bearing: neutralize BEFORE the RFC-4180 quoting, so the guard quote
  // ends up inside the quotes and survives the spreadsheet's unquote. Quoting first
  // would leave the formula char as the cell's first character again.
  const s = neutralizeFormula(String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV serializer for spreadsheet export. Formula-neutralizes every cell — do not
// reuse this for data meant to round-trip back through parseCsv verbatim.
export function toCsv(
  rows: (string | number | null | undefined)[][],
): string {
  return rows.map((r) => r.map(escapeField).join(",")).join("\r\n");
}
