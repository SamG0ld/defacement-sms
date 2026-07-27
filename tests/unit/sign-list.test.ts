import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { toCsv } from "@/lib/csv";
import { parseSignListCsv } from "@/lib/sign-list";

// Contract test for lib/sign-list.ts — the sign-generation input contract that
// reads the app's `/signs/export` CSV. Inline cases pin the rules; the fixture
// round-trip (fixtures/dc33-export-sample.csv) guards the contract against
// export drift. If the export columns or signTypeFromSize buckets change and
// these break, the generators (Figma skill + Python fallback) need updating too.

// Build a CSV the way the real export does (toCsv = formula-safe serializer), so
// these exercise the same quoting/escaping the app emits.
function csv(rows: (string | number)[][]): string {
  return toCsv(rows);
}

const HEADER = ["Item ID", "Sign Text", "Type", "Size", "Zone"];

describe("parseSignListCsv", () => {
  it("renders Sign Text alone, uppercased; Item ID is carried for naming only", () => {
    const { items } = parseSignListCsv(
      csv([HEADER, ["M-001", "Aerospace Village", "22x28", "22x28", "LVCC-H1"]]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: "M-001",
      renderText: "AEROSPACE VILLAGE", // uppercased
      size: "22x28",
      template: '22"x28"',
      zone: "LVCC-H1",
    });
  });

  it("exposes the Room column verbatim when present; '' when absent or no column", () => {
    const header = ["Item ID", "Sign Text", "Type", "Size", "Zone", "Room"];
    const { items } = parseSignListCsv(
      csv([
        header,
        ["W320", "Aerospace Village", "22x28", "22x28", "LVCC-H1", "W320"],
        ["M-7", "No Room Here", "22x28", "22x28", "", ""], // blank Room cell
      ]),
    );
    expect(items[0].room).toBe("W320");
    expect(items[1].room).toBe(""); // blank cell -> ""

    // A DC33-era export with no Room column at all -> room defaults to "".
    const { items: legacy } = parseSignListCsv(
      csv([HEADER, ["M-1", "Poster", "22x28", "22x28", ""]]),
    );
    expect(legacy[0].room).toBe("");
  });

  it("exposes back-face text uppercased when the Back Text column is present; '' otherwise", () => {
    const header = [
      "Item ID",
      "Sign Text",
      "Type",
      "Size",
      "Double-Sided",
      "Back Text",
    ];
    const { items } = parseSignListCsv(
      csv([
        header,
        ["W204", "Workshop A", "", "4'x8' Double", "Yes", "Workshop B"],
        ["W205", "Single Face", "", "4'x8' Single", "No", ""], // blank back text
      ]),
    );
    expect(items[0].backText).toBe("WORKSHOP B"); // uppercased like renderText
    expect(items[1].backText).toBe("");

    // Legacy export with no Back Text column at all -> "".
    const { items: legacy } = parseSignListCsv(
      csv([HEADER, ["M-1", "Poster", "22x28", "22x28", ""]]),
    );
    expect(legacy[0].backText).toBe("");
  });

  it("maps each Size to its template/canvas bucket via signTypeFromSize", () => {
    const { items } = parseSignListCsv(
      csv([
        HEADER,
        ["M-1", "A", "", "22x28", ""],
        ["M-2", "B", "", "24x36", ""],
        ["M-3", "C", "", "Meterboard (4x8)", ""],
        ["M-4", "D", "", "Banner", ""],
        ["M-5", "E", "", "Socks", ""],
        ["M-6", "F", "", "8x20", ""],
        ["M-7", "G", "", "", ""], // no size -> generic "Sign"
      ]),
    );
    expect(items.map((i) => i.template)).toEqual([
      '22"x28"',
      '24"x36"',
      "Meterboard (4'x8')",
      "Banner",
      "Socks",
      "8'x20'",
      "Sign",
    ]);
  });

  it("groups items by template in first-seen order", () => {
    const { groups } = parseSignListCsv(
      csv([
        HEADER,
        ["M-1", "Poster A", "", "22x28", ""],
        ["M-2", "Meter A", "", "Meterboard (4x8)", ""],
        ["M-3", "Poster B", "", "22x28", ""],
      ]),
    );
    expect(groups.map((g) => g.template)).toEqual(['22"x28"', "Meterboard (4'x8')"]);
    expect(groups[0].items.map((i) => i.renderText)).toEqual(["POSTER A", "POSTER B"]);
    expect(groups[1].items).toHaveLength(1);
  });

  it("splits a 4'x8' Double into its own generation group (two print faces)", () => {
    const header = ["Item ID", "Sign Text", "Type", "Size", "Double-Sided"];
    const { groups } = parseSignListCsv(
      csv([
        header,
        ["M-1", "Track 1", "", "4'x8' Single", "No"],
        ["M-2", "Track 2", "", "4'x8' Double", "Yes"],
        ["M-3", "Track 3", "", "4'x8' Single", "No"],
      ]),
    );
    // Same template ("Meterboard (4'x8')") but single vs double are distinct groups,
    // so a Double is never folded into the Single meterboard batch.
    expect(
      groups.map((g) => [g.template, g.doubleSided, g.items.length]),
    ).toEqual([
      ["Meterboard (4'x8')", false, 2],
      ["Meterboard (4'x8')", true, 1],
    ]);
  });

  it("derives doubleSided (explicit column wins, else the size heuristic)", () => {
    // Explicit column authoritative.
    const withCol = parseSignListCsv(
      csv([
        ["Item ID", "Sign Text", "Type", "Size", "Double-Sided"],
        ["M-1", "A", "", "22x28", "Yes"], // non-double size, explicit Yes
        ["M-2", "B", "", "4'x8' Double", "No"], // explicit No beats the size
      ]),
    );
    expect(withCol.items.map((i) => i.doubleSided)).toEqual([true, false]);

    // No column → fall back to the size string.
    const noCol = parseSignListCsv(
      csv([
        ["Item ID", "Sign Text", "Type", "Size"],
        ["M-1", "A", "", "4'x8' Double"],
        ["M-2", "B", "", "4'x8' Single"],
      ]),
    );
    expect(noCol.items.map((i) => i.doubleSided)).toEqual([true, false]);
  });

  it("skips rows with blank Sign Text (recording why) and fully-blank rows", () => {
    const { items, skipped } = parseSignListCsv(
      csv([
        HEADER,
        ["M-1", "Keep Me", "", "22x28", ""],
        ["M-2", "", "", "24x36", ""], // blank Sign Text -> skipped
        ["", "", "", "", ""], // fully blank -> silently skipped
      ]),
    );
    expect(items.map((i) => i.renderText)).toEqual(["KEEP ME"]);
    expect(skipped).toEqual([{ line: 3, reason: "blank Sign Text" }]);
  });

  it("ignores non-contract export columns and resolves Sign Text by alias", () => {
    // Full export header set; Sign Text via the "Text" alias, Item ID via "Map#".
    const header = ["Map#", "Text", "Size", "Qty", "Status", "Zone", "Notes"];
    const { items } = parseSignListCsv(
      csv([header, ["P1", "Pool Party", "22x28", "1", "pending", "LVCC-L1", "hi"]]),
    );
    expect(items[0]).toMatchObject({ itemId: "P1", renderText: "POOL PARTY" });
  });

  it("strips the export's formula-injection guard but keeps the real leading char", () => {
    // toCsv prefixes a single quote to a cell starting with a formula char
    // (here "-"). The parser must strip the guard quote, not the intended dash.
    const { items } = parseSignListCsv(
      csv([HEADER, ["M-1", "-MINUS ROOM", "", "22x28", ""]]),
    );
    expect(items[0].renderText).toBe("-MINUS ROOM");
  });

  it("throws when the required Sign Text column is absent", () => {
    expect(() => parseSignListCsv(csv([["Item ID", "Size"], ["M-1", "22x28"]]))).toThrow(
      /sign text/i,
    );
  });

  it("throws on an empty file (no header)", () => {
    expect(() => parseSignListCsv("")).toThrow(/empty/i);
  });
});

describe("parseSignListCsv — DC33 export fixture", () => {
  const text = readFileSync(
    join(process.cwd(), "fixtures", "dc33-export-sample.csv"),
    "utf8",
  );

  it("parses the fixture into the expected size-grouped batch", () => {
    const { items, groups, skipped } = parseSignListCsv(text);

    expect(items).toHaveLength(13);
    expect(skipped).toHaveLength(0);

    // Group -> item count, in first-seen order. Guards both the parser and the
    // fixture's bucket coverage.
    const summary = groups.map((g) => [g.template, g.items.length] as const);
    expect(summary).toEqual([
      ['22"x28"', 5],
      ['24"x36"', 2],
      ["Banner", 1],
      ["Meterboard (4'x8')", 2],
      ["Socks", 1],
      ["8'x20'", 1],
      ["Sign", 1],
    ]);

    // Render strings are uppercased; "DEF CON" stays intact for the chunker.
    expect(items[0].renderText).toBe("DEF CON REGISTRATION");
  });
});
