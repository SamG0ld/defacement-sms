import { describe, it, expect } from "vitest";

import {
  auditSigns,
  findResizeDrift,
  findStalePlaceholders,
  findVariantCodeDupes,
  findFillDownDupes,
  findFormatMismatches,
  findUnconfirmed,
  findUnrenderable,
  isPlaceholderText,
  type AuditSign,
  type DriftBatch,
} from "@/lib/sign-audit";

// Build an AuditSign with sensible defaults; override per case. Defaults are an
// on-format foamcore 22x28 (signType + category agree with the size) so a case only
// trips format-mismatch when it deliberately overrides one.
function sign(over: Partial<AuditSign> = {}): AuditSign {
  return {
    itemId: "W100",
    signText: "A Village",
    size: "22x28",
    signType: '22"x28"',
    category: "easel_sign",
    zone: "LVCC-H1",
    tags: ["master-sheet"],
    ...over,
  };
}

describe("isPlaceholderText", () => {
  it("matches TBA / TBD / empty, not real names", () => {
    expect(isPlaceholderText("Exhibitors TBA")).toBe(true);
    expect(isPlaceholderText("TBD - Empty")).toBe(true);
    expect(isPlaceholderText("Zyn")).toBe(false);
    expect(isPlaceholderText("Aerospace Village")).toBe(false);
  });
});

describe("findStalePlaceholders", () => {
  it("flags a placeholder at a booth that also has a real name", () => {
    const signs = [
      sign({ itemId: "1405", signText: "Flare.io" }),
      sign({ itemId: "1405", signText: "Exhibitors TBA" }),
    ];
    const out = findStalePlaceholders(signs);
    expect(out).toHaveLength(1);
    expect(out[0].signs.map((s) => s.signText)).toEqual(["Exhibitors TBA"]);
  });

  it("leaves a booth with ONLY placeholders alone (genuinely unassigned)", () => {
    const signs = [
      sign({ itemId: "1403", signText: "Exhibitors TBA" }),
      sign({ itemId: "1403", signText: "TBD - Empty" }),
    ];
    expect(findStalePlaceholders(signs)).toHaveLength(0);
  });
});

describe("findVariantCodeDupes", () => {
  it("flags one space entered under two room-code spellings, one finding PER SIZE", () => {
    // A booth's meterboard + sock are distinct signs; under two spellings that's 4
    // rows = 2 true dupe pairs (one per size), NOT one 4-row finding — otherwise the
    // "keep one, drop the rest" guidance would over-delete a real sign.
    const signs = [
      sign({ itemId: "W204, W205", signText: "Payment Village", size: "4'x8' Double" }),
      sign({ itemId: "W204, W205", signText: "Payment Village", size: "Socks" }),
      sign({ itemId: "W204-W205", signText: "Payment Village", size: "4'x8' Double" }),
      sign({ itemId: "W204-W205", signText: "Payment Village", size: "Socks" }),
    ];
    const out = findVariantCodeDupes(signs);
    expect(out).toHaveLength(2); // one per size
    expect(out.every((f) => f.signs.length === 2)).toBe(true);
  });

  it("does NOT flag a village's meterboard + sock at ONE room code (same raw itemId)", () => {
    const signs = [
      sign({ itemId: "W311", signText: "Cloud Village", size: "4'x8' Double" }),
      sign({ itemId: "W311", signText: "Cloud Village", size: "Socks" }),
    ];
    expect(findVariantCodeDupes(signs)).toHaveLength(0);
  });
});

describe("findFillDownDupes", () => {
  it("flags the same real name across distinct booths", () => {
    const signs = [
      sign({ itemId: "1400", signText: "Zyn" }),
      sign({ itemId: "1401", signText: "Zyn" }),
      sign({ itemId: "1402", signText: "Zyn" }),
    ];
    const out = findFillDownDupes(signs);
    expect(out).toHaveLength(1);
    expect(out[0].signs).toHaveLength(3);
  });

  it("excludes all-venue multi-copy signage (intentional)", () => {
    const signs = [
      sign({ itemId: "AV-COC-01", signText: "Code of Conduct", tags: ["all-venue"] }),
      sign({ itemId: "AV-COC-02", signText: "Code of Conduct", tags: ["all-venue"] }),
    ];
    expect(findFillDownDupes(signs)).toHaveLength(0);
  });
});

describe("findUnconfirmed", () => {
  it("counts needs-confirmation rows as one informational finding", () => {
    const signs = [
      sign({ tags: ["master-sheet", "needs-confirmation"] }),
      sign({ tags: ["master-sheet"] }),
    ];
    const out = findUnconfirmed(signs);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("info");
    expect(out[0].signs).toHaveLength(1);
  });
});

describe("findUnrenderable", () => {
  it("flags blank text, unspecified size, and over-long text", () => {
    expect(findUnrenderable([sign({ signText: "" })])).toHaveLength(1);
    expect(findUnrenderable([sign({ size: "Unspecified" })])).toHaveLength(1);
    expect(findUnrenderable([sign({ signText: "x".repeat(90) })])).toHaveLength(1);
    expect(findUnrenderable([sign()])).toHaveLength(0);
  });
});

describe("findFormatMismatches", () => {
  it("flags the 1004/1101 bug: size stays a meterboard but type/category became a poster", () => {
    const out = findFormatMismatches([
      sign({
        itemId: "1004",
        size: "4'x8' Single", // still a meterboard size → generator batches as 4'x8'
        signType: '22"x28"', // but re-typed as a poster
        category: "easel_sign",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].message).toMatch(/should be "Meterboard \(4'x8'\)"/);
    expect(out[0].message).toMatch(/should be "meterboard"/);
  });

  it("does NOT flag an on-format sign", () => {
    expect(findFormatMismatches([sign()])).toHaveLength(0); // default is on-format
    expect(
      findFormatMismatches([
        sign({ size: "4'x8' Double", signType: "Meterboard (4'x8')", category: "meterboard" }),
      ]),
    ).toHaveLength(0);
  });

  it("does NOT false-flag a printed ops map (keyed off the Format table, not a size regex)", () => {
    // Size "4'x8' printed" dimension-derives to a meterboard, but its canonical format
    // is an ops_map typed "4'x8' printed" — so an ops map stored that way is clean.
    expect(
      findFormatMismatches([
        sign({ size: "4'x8' printed", signType: "4'x8' printed", category: "ops_map" }),
      ]),
    ).toHaveLength(0);
  });

  it("ignores off-format sizes (a size-cleanup concern, not this rule's)", () => {
    // The quoted 24"x36" twin isn't a canonical format size → out of scope here.
    expect(
      findFormatMismatches([
        sign({ size: '24"x36"', signType: "anything", category: "meterboard" }),
      ]),
    ).toHaveLength(0);
  });

  it("skips a half whose column the source didn't provide (undefined), but checks a blank one", () => {
    // signType undefined (no Type column) → only category is checked.
    expect(
      findFormatMismatches([
        sign({ size: "22x28", signType: undefined, category: "easel_sign" }),
      ]),
    ).toHaveLength(0);
    // A present-but-blank category on an on-format size IS a mismatch.
    expect(
      findFormatMismatches([
        sign({ size: "22x28", signType: '22"x28"', category: "" }),
      ]),
    ).toHaveLength(1);
  });
});

describe("findResizeDrift", () => {
  // A batch generated as 22×28 (four signs) with one sign later resized to 24×36.
  const batch: DriftBatch = {
    batchId: 7,
    signs: [
      { id: 1, itemId: "W100", size: "22x28" },
      { id: 2, itemId: "W101", size: "22x28" },
      { id: 3, itemId: "W102", size: "22x28" },
      { id: 4, itemId: "W103", size: "24x36" }, // moved
    ],
  };

  it("flags exactly the resized sign, with from/to bucket labels", () => {
    const out = findResizeDrift([batch]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      signId: 4,
      itemId: "W103",
      batchId: 7,
      from: "Foamcore 22×28",
      to: "Foamcore 24×36",
    });
  });

  it("flags nothing for a pure single-bucket batch", () => {
    const out = findResizeDrift([
      {
        batchId: 9,
        signs: [
          { id: 10, itemId: "M1", size: "4'x8' Single" },
          { id: 11, itemId: "M2", size: "4'x8' Single" },
        ],
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("ignores an empty batch", () => {
    expect(findResizeDrift([{ batchId: 1, signs: [] }])).toHaveLength(0);
  });

  it("on an exact tie, first-seen bucket is home; the other half is flagged (deterministic)", () => {
    // A genuine 2-2 split can't say which half "moved" — pin the deterministic
    // first-seen-wins behaviour so a future refactor can't change it silently.
    const out = findResizeDrift([
      {
        batchId: 3,
        signs: [
          { id: 1, itemId: "A", size: "22x28" },
          { id: 2, itemId: "B", size: "22x28" },
          { id: 3, itemId: "C", size: "24x36" },
          { id: 4, itemId: "D", size: "24x36" },
        ],
      },
    ]);
    expect(out.map((d) => d.signId).sort()).toEqual([3, 4]);
    expect(out.every((d) => d.from === "Foamcore 22×28")).toBe(true);
  });
});

describe("auditSigns", () => {
  it("runs every rule and tallies counts", () => {
    const signs = [
      sign({ itemId: "1405", signText: "Flare.io" }),
      sign({ itemId: "1405", signText: "Exhibitors TBA", tags: ["master-sheet", "needs-confirmation"] }),
    ];
    const report = auditSigns(signs);
    expect(report.counts["stale-placeholder"]).toBe(1);
    expect(report.counts["unconfirmed"]).toBe(1);
    expect(report.findings.length).toBeGreaterThanOrEqual(2);
  });
});
