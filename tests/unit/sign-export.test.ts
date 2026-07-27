import { describe, it, expect } from "vitest";

import { parseCsv } from "@/lib/csv";
import { isValidFigmaUrl } from "@/lib/figma";
import {
  SIGN_EXPORT_HEADER,
  signRowsToCsv,
  signRowsToSectionedCsv,
  type SignExportRow,
} from "@/lib/sign-export";

// A minimal export row; override per case.
function row(over: Partial<SignExportRow> = {}): SignExportRow {
  return {
    itemId: "M-001",
    signText: "Aerospace Village",
    backText: null,
    signType: "22x28",
    size: "22x28",
    category: "easel_sign",
    quantity: 1,
    doubleSided: false,
    needsEasel: true,
    status: "pending",
    placementArea: null,
    exactDestination: null,
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
  // Drift guard (#243): the cell list and the header are two hand-maintained
  // lists that must stay the same width — adding a header without a cell (or
  // vice versa) silently shifts every later field in the machine-reimported CSV.
  // Asserting against SIGN_EXPORT_HEADER.length (not a literal) is what makes a
  // mismatch fail here instead of relying on a prose column count in a comment.
  it("emits exactly one cell per header column (flat and sectioned)", () => {
    const flat = parseCsv(signRowsToCsv([row()]));
    expect(flat[1]).toHaveLength(SIGN_EXPORT_HEADER.length);
    // [header, section marker, data row]
    const sectioned = parseCsv(signRowsToSectionedCsv([row()]));
    expect(sectioned[0]).toHaveLength(SIGN_EXPORT_HEADER.length);
    expect(sectioned[2]).toHaveLength(SIGN_EXPORT_HEADER.length);
  });

  it("emits the 20-column header then one row per sign", () => {
    const csv = signRowsToCsv([row()]);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([...SIGN_EXPORT_HEADER]);
    expect(SIGN_EXPORT_HEADER).toHaveLength(20);
    // Room sits immediately after Placement.
    expect(SIGN_EXPORT_HEADER[9]).toBe("Placement");
    expect(SIGN_EXPORT_HEADER[10]).toBe("Room");
    // Category then Back Text are appended after the original 18 (append-only).
    expect(SIGN_EXPORT_HEADER[18]).toBe("Category");
    expect(SIGN_EXPORT_HEADER[19]).toBe("Back Text");
    expect(parsed).toHaveLength(2);
    expect(parsed[1][0]).toBe("M-001");
    expect(parsed[1][1]).toBe("Aerospace Village");
    expect(parsed[1][8]).toBe("LVCC-H1"); // Zone column
    expect(parsed[1][18]).toBe("easel_sign"); // Category column
  });

  it("exports backText in the Back Text column; null stays blank", () => {
    const [, set] = parseCsv(
      signRowsToCsv([row({ doubleSided: true, backText: "Exit / Salida" })]),
    );
    expect(set[19]).toBe("Exit / Salida"); // Back Text
    const [, blank] = parseCsv(signRowsToCsv([row({ backText: null })]));
    expect(blank[19]).toBe(""); // Back Text blank when unset
  });

  it("exports exactDestination in the Room column; null stays blank", () => {
    const [, set] = parseCsv(signRowsToCsv([row({ exactDestination: "W320" })]));
    expect(set[10]).toBe("W320"); // Room
    const [, blank] = parseCsv(signRowsToCsv([row({ exactDestination: null })]));
    expect(blank[10]).toBe(""); // Room blank when unset
  });

  it("formats money via Decimal.toFixed, booleans as Yes/No, joins tags", () => {
    const csv = signRowsToCsv([
      row({
        doubleSided: true,
        costPerUnit: { toFixed: (n: number) => (12).toFixed(n) },
        totalCost: { toFixed: (n: number) => (24).toFixed(n) },
        // "meterboard" is a slug whose display name ("Meter Board") would slugify
        // to "meter-board" — so this asserts the slug is serialized, not the name.
        tagAssignments: [{ tag: { slug: "village" } }, { tag: { slug: "meterboard" } }],
      }),
    ]);
    const [, r] = parseCsv(csv);
    expect(r[5]).toBe("Yes"); // Double-Sided
    expect(r[6]).toBe("Yes"); // Needs Easel
    expect(r[13]).toBe("12.00"); // Cost/Unit
    expect(r[14]).toBe("24.00"); // Total Cost
    expect(r[16]).toBe("village; meterboard"); // Tags (slugs, not display names)
  });

  it("blank zone/optional fields become empty cells", () => {
    const [, r] = parseCsv(signRowsToCsv([row({ zone: null })]));
    expect(r[8]).toBe(""); // Zone
    expect(r[9]).toBe(""); // Placement
    expect(r[10]).toBe(""); // Room (null)
    expect(r[13]).toBe(""); // Cost/Unit (null)
  });

  it("neutralizes a formula-leading sign text (toCsv guard)", () => {
    // A name like "-LOBBY" must export as a guarded cell, not a live formula.
    const [, r] = parseCsv(signRowsToCsv([row({ signText: "-LOBBY" })]));
    expect(r[1]).toBe("'-LOBBY");
  });
});

describe("signRowsToSectionedCsv", () => {
  it("groups rows into === FORMAT === sections in format order, custom last", () => {
    const csv = signRowsToSectionedCsv([
      row({ itemId: "S-1", size: "Socks" }),
      row({ itemId: "C-1", size: "totally custom" }),
      row({ itemId: "F-1", size: "22x28" }),
      row({ itemId: "M-1", size: "4'x8' Double" }),
    ]);
    const parsed = parseCsv(csv);
    // Header first.
    expect(parsed[0]).toEqual([...SIGN_EXPORT_HEADER]);
    // Section markers, in table order: 22×28 → meterboard double → socks → custom.
    const markers = parsed
      .map((r) => r[0])
      .filter((c) => c.includes("==="));
    expect(markers).toEqual([
      "'=== Foamcore 22×28 (1 sign) ===", // leading ' is the toCsv formula guard
      "'=== Meterboard 4'×8' Double (1 sign) ===",
      "'=== Socks (1 sign) ===",
      "'=== Other / custom (1 sign) ===",
    ]);
  });

  it("orders rows within a section by Item ID and keeps the full column shape", () => {
    const csv = signRowsToSectionedCsv([
      row({ itemId: "F-3", size: "22x28" }),
      row({ itemId: "F-1", size: "22x28" }),
      row({ itemId: "F-2", size: "22x28" }),
    ]);
    const parsed = parseCsv(csv);
    // [header, section marker, F-1, F-2, F-3]
    expect(parsed[1][0]).toContain("=== Foamcore 22×28 (3 signs) ===");
    expect(parsed.slice(2).map((r) => r[0])).toEqual(["F-1", "F-2", "F-3"]);
    // Data rows keep the full column shape.
    expect(parsed[2]).toHaveLength(SIGN_EXPORT_HEADER.length);
  });

  it("is NOT round-trippable — the section markers are non-data rows", () => {
    // Guards the contract: this report must never be fed back through the
    // importer. A section marker row has a single cell that is not an Item ID,
    // so it's structurally distinct from a data row.
    const parsed = parseCsv(
      signRowsToSectionedCsv([row({ itemId: "F-1", size: "22x28" })]),
    );
    const marker = parsed[1];
    expect(marker).toHaveLength(1); // not the full data-row shape
    expect(marker[0]).not.toBe("F-1");
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
