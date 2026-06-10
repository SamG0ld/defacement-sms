import { describe, it, expect } from "vitest";

import { parseCsv, toCsv } from "@/lib/csv";

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
});
