import { describe, it, expect } from "vitest";

import {
  filterSignsByQuery,
  normalizeQuery,
  signMatchesQuery,
} from "@/app/(app)/deploy/_lib/search";

const sign = (itemId: string, signText: string) => ({ itemId, signText });

describe("normalizeQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeQuery("  AB-12  ")).toBe("ab-12");
  });

  it("collapses an all-whitespace query to empty", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("signMatchesQuery", () => {
  const s = sign("HW-204", "Registration This Way");

  it("matches everything on an empty or whitespace query", () => {
    expect(signMatchesQuery(s, "")).toBe(true);
    expect(signMatchesQuery(s, "   ")).toBe(true);
  });

  it("matches on item ID, case-insensitively", () => {
    expect(signMatchesQuery(s, "hw-204")).toBe(true);
    expect(signMatchesQuery(s, "HW")).toBe(true);
  });

  it("matches on a partial item ID", () => {
    expect(signMatchesQuery(s, "204")).toBe(true);
  });

  it("matches on sign text, case-insensitively", () => {
    expect(signMatchesQuery(s, "registration")).toBe(true);
    expect(signMatchesQuery(s, "this way")).toBe(true);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(signMatchesQuery(s, "  204  ")).toBe(true);
  });

  it("returns false when neither field contains the query", () => {
    expect(signMatchesQuery(s, "exit")).toBe(false);
  });

  it("falls back to itemId match when signText is empty", () => {
    const blank = sign("HW-999", "");
    expect(signMatchesQuery(blank, "hw-999")).toBe(true);
    expect(signMatchesQuery(blank, "room")).toBe(false);
  });
});

describe("filterSignsByQuery", () => {
  const signs = [
    sign("HW-204", "Registration This Way"),
    sign("HW-205", "Quiet Room"),
    sign("AV-101", "Main Stage"),
  ];

  it("returns a copy of all signs on an empty query", () => {
    const result = filterSignsByQuery(signs, "");
    expect(result).toHaveLength(3);
    expect(result).not.toBe(signs);
  });

  it("filters to matching signs by item ID", () => {
    expect(filterSignsByQuery(signs, "hw-").map((s) => s.itemId)).toEqual([
      "HW-204",
      "HW-205",
    ]);
  });

  it("filters to matching signs by sign text", () => {
    expect(filterSignsByQuery(signs, "stage").map((s) => s.itemId)).toEqual([
      "AV-101",
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterSignsByQuery(signs, "zzz")).toEqual([]);
  });
});
