import { describe, it, expect } from "vitest";

import { parseCsv, stripFormulaGuard, toCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
    expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("﻿a,b")).toEqual([["a", "b"]]);
  });

  it("handles CRLF and lone-CR line endings", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a\rb")).toEqual([["a"], ["b"]]);
  });

  // RFC 4180 (what Excel/Sheets emit) only treats a `"` as field quoting at the
  // START of a field. A quote mid-field is literal data — and the app's own size
  // vocabulary is inch marks (22"x28", 24"x36"), so a hand-edited or non-Excel CSV
  // carries them routinely. Treating those as quoting swallowed the rest of the row
  // — and the row after it — into a single field (#174).
  it("keeps an inch mark mid-field literal instead of opening a quoted field", () => {
    expect(parseCsv('a,24"x36",c')).toEqual([["a", '24"x36"', "c"]]);
  });

  it("does not swallow later delimiters after an unpaired mid-field quote", () => {
    expect(parseCsv('M-006,Betty\'s 22" Sign,Hall 1,Wed AM,notes here')).toEqual([
      ["M-006", 'Betty\'s 22" Sign', "Hall 1", "Wed AM", "notes here"],
    ]);
  });

  it("does not merge the next row into an unpaired-quote field", () => {
    expect(parseCsv('M-007,a 5" sign,x\nM-008,b,y')).toEqual([
      ["M-007", 'a 5" sign', "x"],
      ["M-008", "b", "y"],
    ]);
  });
});

describe("toCsv", () => {
  it("neutralizes spreadsheet formula prefixes", () => {
    expect(toCsv([["=SUM(A1)", "+1", "-2", "@x", "normal"]])).toBe(
      "'=SUM(A1),'+1,'-2,'@x,normal",
    );
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    expect(toCsv([["a,b", 'he "q"', "line\nbreak"]])).toBe(
      '"a,b","he ""q""","line\nbreak"',
    );
  });

  it("renders numbers and null/undefined as empty", () => {
    expect(toCsv([[1, null, undefined]])).toBe("1,,");
  });

  it("joins rows with CRLF", () => {
    expect(toCsv([["a"], ["b"]])).toBe("a\r\nb");
  });

  // A value that ALREADY begins with apostrophes then a formula char is
  // indistinguishable from a guarded value once written, so it earns its own guard
  // quote — that's what makes the guard reversible on re-import (#202).
  it("escapes a value that would otherwise re-import as a formula", () => {
    expect(toCsv([["'=SUM(A1)"]])).toBe("''=SUM(A1)");
    expect(toCsv([["''=SUM(A1)"]])).toBe("'''=SUM(A1)");
  });

  it("leaves an apostrophe followed by a non-formula char unguarded", () => {
    expect(toCsv([["'24 reunion"]])).toBe("'24 reunion");
  });
});

describe("stripFormulaGuard", () => {
  it("is the exact inverse of the export guard", () => {
    for (const raw of [
      "=SUM(A1)",
      "+1 BADGE PICKUP",
      "-MINUS ROOM",
      "@here",
      "'=SUM(A1)", // apostrophe the user typed, not the guard
      "''=x",
      "'24 reunion", // apostrophe then a non-formula char — never guarded
      "plain text",
    ]) {
      expect(stripFormulaGuard(toCsv([[raw]]))).toBe(raw);
    }
  });

  it("still strips the single guard quote written by an older export", () => {
    expect(stripFormulaGuard("'=SUM(A1)")).toBe("=SUM(A1)");
  });

  it("leaves an unguarded value untouched", () => {
    expect(stripFormulaGuard("'24 reunion")).toBe("'24 reunion");
    expect(stripFormulaGuard("Aerospace Village")).toBe("Aerospace Village");
  });
});
