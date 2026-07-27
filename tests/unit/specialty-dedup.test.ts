import { describe, it, expect } from "vitest";

import {
  softDupKey,
  detectSoftDuplicates,
} from "@/app/(app)/signs/specialty/_dedup";

describe("softDupKey", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(softDupKey("  Main Stage  ", " 24x36 ")).toBe(
      softDupKey("main stage", "24x36"),
    );
  });

  it("distinguishes different text or size", () => {
    expect(softDupKey("A", "24x36")).not.toBe(softDupKey("B", "24x36"));
    expect(softDupKey("A", "24x36")).not.toBe(softDupKey("A", "18x24"));
  });
});

describe("detectSoftDuplicates", () => {
  it("hints a later row that matches an earlier batch row (points at the first)", () => {
    const hints = detectSoftDuplicates(
      [
        { signText: "Registration", size: "24x36" },
        { signText: "Other", size: "24x36" },
        { signText: "registration", size: "24X36" }, // case/space variant of row 1
      ],
      new Set(),
    );
    expect(hints[0]).toBeNull();
    expect(hints[1]).toBeNull();
    expect(hints[2]).toBe("possible duplicate — same text + size as row 1");
  });

  it("hints a row matching an existing sign", () => {
    const existing = new Set([softDupKey("Registration", "24x36")]);
    const hints = detectSoftDuplicates(
      [{ signText: "Registration", size: "24x36" }],
      existing,
    );
    expect(hints[0]).toBe(
      "possible duplicate — same text + size as an existing sign",
    );
  });

  it("prefers the batch-row hint over the existing-sign hint", () => {
    const existing = new Set([softDupKey("Registration", "24x36")]);
    const hints = detectSoftDuplicates(
      [
        { signText: "Registration", size: "24x36" },
        { signText: "Registration", size: "24x36" },
      ],
      existing,
    );
    // First occurrence collides with the DB; second collides with the batch.
    expect(hints[0]).toBe(
      "possible duplicate — same text + size as an existing sign",
    );
    expect(hints[1]).toBe("possible duplicate — same text + size as row 1");
  });

  it("never hints rows missing text or size", () => {
    const hints = detectSoftDuplicates(
      [
        { signText: "", size: "24x36" },
        { signText: "Registration", size: "" },
        { signText: "   ", size: "   " },
      ],
      new Set(),
    );
    expect(hints).toEqual([null, null, null]);
  });

  it("returns null for unique rows", () => {
    const hints = detectSoftDuplicates(
      [
        { signText: "A", size: "24x36" },
        { signText: "B", size: "18x24" },
      ],
      new Set(),
    );
    expect(hints).toEqual([null, null]);
  });
});
