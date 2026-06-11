import { describe, it, expect } from "vitest";

import { parseCsv } from "@/lib/csv";
import { isValidFigmaUrl } from "@/lib/figma";
import {
  SIGN_EXPORT_HEADER,
  signRowsToCsv,
  type SignExportRow,
} from "@/lib/sign-export";

// A minimal export row; override per case.
function row(over: Partial<SignExportRow> = {}): SignExportRow {
  return {
    itemId: "M-001",
    signText: "Aerospace Village",
    signType: "22x28",
    size: "22x28",
    quantity: 1,
    doubleSided: false,
    needsEasel: true,
    status: "pending",
    placementArea: null,
    deploymentSlot: null,
    deploymentPriority: 2,
    costPerUnit: null,
    totalCost: null,
    requestor: null,
    notes: null,
    zone: { zoneCode: "LVCC-H1" },
    tagAssignments: [],
    ...over,
  };
}

describe("signRowsToCsv", () => {
  it("emits the 17-column header then one row per sign", () => {
    const csv = signRowsToCsv([row()]);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([...SIGN_EXPORT_HEADER]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1][0]).toBe("M-001");
    expect(parsed[1][1]).toBe("Aerospace Village");
    expect(parsed[1][8]).toBe("LVCC-H1"); // Zone column
  });

  it("formats money via Decimal.toFixed, booleans as Yes/No, joins tags", () => {
    const csv = signRowsToCsv([
      row({
        doubleSided: true,
        costPerUnit: { toFixed: (n: number) => (12).toFixed(n) },
        totalCost: { toFixed: (n: number) => (24).toFixed(n) },
        tagAssignments: [{ tag: { name: "village" } }, { tag: { name: "priority" } }],
      }),
    ]);
    const [, r] = parseCsv(csv);
    expect(r[5]).toBe("Yes"); // Double-Sided
    expect(r[6]).toBe("Yes"); // Needs Easel
    expect(r[12]).toBe("12.00"); // Cost/Unit
    expect(r[13]).toBe("24.00"); // Total Cost
    expect(r[15]).toBe("village; priority"); // Tags
  });

  it("blank zone/optional fields become empty cells", () => {
    const [, r] = parseCsv(signRowsToCsv([row({ zone: null })]));
    expect(r[8]).toBe(""); // Zone
    expect(r[9]).toBe(""); // Placement
    expect(r[12]).toBe(""); // Cost/Unit (null)
  });

  it("neutralizes a formula-leading sign text (toCsv guard)", () => {
    // A name like "-LOBBY" must export as a guarded cell, not a live formula.
    const [, r] = parseCsv(signRowsToCsv([row({ signText: "-LOBBY" })]));
    expect(r[1]).toBe("'-LOBBY");
  });
});

describe("isValidFigmaUrl", () => {
  it("accepts https figma.com URLs (incl. subdomains)", () => {
    expect(isValidFigmaUrl("https://www.figma.com/design/abc123/DC34-Signs")).toBe(true);
    expect(isValidFigmaUrl("https://figma.com/file/xyz")).toBe(true);
    expect(isValidFigmaUrl("  https://www.figma.com/design/abc  ")).toBe(true); // trimmed
  });

  it("rejects non-https, non-figma hosts, and dangerous schemes", () => {
    expect(isValidFigmaUrl("http://figma.com/design/abc")).toBe(false); // not https
    expect(isValidFigmaUrl("https://evil.com/design/abc")).toBe(false);
    expect(isValidFigmaUrl("https://notfigma.com")).toBe(false);
    expect(isValidFigmaUrl("https://figma.com.evil.com")).toBe(false); // suffix trick
    expect(isValidFigmaUrl("javascript:alert(1)")).toBe(false);
    expect(isValidFigmaUrl("not a url")).toBe(false);
    expect(isValidFigmaUrl("")).toBe(false);
  });
});
