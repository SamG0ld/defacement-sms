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

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
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
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    // Plain run: extend to the next delimiter in one slice. Starting at i + 1
    // is safe because the guards above already excluded every delimiter/quote
    // as `c` — keep that invariant if adding branches above.
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"' || ch === "," || ch === "\r" || ch === "\n") break;
      j++;
    }
    field += text.slice(i, j);
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
function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
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
