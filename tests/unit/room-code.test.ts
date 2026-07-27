import { describe, it, expect } from "vitest";

import { normalizeRoomCode } from "@/lib/room-code";

describe("normalizeRoomCode", () => {
  it("collapses the real variant-spelling pairs seen in prod to one key", () => {
    // Each pair is the SAME physical space written two ways — must normalize equal.
    const same: [string, string][] = [
      ["W204, W205", "W204-W205"],
      ["W219 -W220", "W219, W220"],
      ["W226, W227", "W226-W227"],
      ["W103-W105 + W107-W109", "W103-W105-W107-W109"],
    ];
    for (const [a, b] of same) {
      expect(normalizeRoomCode(a)).toBe(normalizeRoomCode(b));
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeRoomCode("  w320 ")).toBe("W320");
    expect(normalizeRoomCode("North Lobby")).toBe("NORTH-LOBBY");
  });

  it("leaves plain codes and ranges untouched", () => {
    expect(normalizeRoomCode("W320")).toBe("W320");
    expect(normalizeRoomCode("1400")).toBe("1400");
    expect(normalizeRoomCode("W303-310")).toBe("W303-310");
  });

  it("does NOT collapse typos or reorderings (left for the audit to flag)", () => {
    // "1W05" is a typo of "W105" — must stay distinct, not silently merged.
    expect(normalizeRoomCode("W103-1W05,W107-W109")).not.toBe(
      normalizeRoomCode("W103-W105 + W107-W109"),
    );
    // token order is preserved (no risky sort that could merge different spaces)
    expect(normalizeRoomCode("W205, W204")).not.toBe(normalizeRoomCode("W204, W205"));
  });

  it("handles empty / separator-only input", () => {
    expect(normalizeRoomCode("")).toBe("");
    expect(normalizeRoomCode("  ,  ")).toBe("");
  });

  it("ACCEPTED TRADEOFF: an abbreviated comma-list collapses onto a range", () => {
    // Unifying "," and "-" is what lets "W204, W205" match "W204-W205" (the real,
    // observed variant). The side effect is that a hypothetical prefix-omitting
    // comma-list ("W303, 310") also normalizes onto the range "W303-310". Bounded by
    // the compound identity (same code AND same sheetName AND same size still required
    // to merge), and not seen in the real sheet (codes repeat the full prefix). Pinned
    // here so the tradeoff is conscious, not an unnoticed regression.
    expect(normalizeRoomCode("W303, 310")).toBe(normalizeRoomCode("W303-310"));
  });
});
