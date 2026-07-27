// CSV round-trip integrity (M17 Track C). Drives the full cycle a user hits when
// they export from /signs, edit in a spreadsheet, and re-import:
//   signRowsToCsv  →  parseCsv  →  buildPreview (generic import)
// Each case guards a silent corruption the audit found in that cycle.
import { describe, it, expect } from "vitest";

import { parseCsv } from "@/lib/csv";
import { signRowsToCsv, type SignExportRow } from "@/lib/sign-export";
import { buildPreview } from "@/app/(app)/signs/import/_map";
import { makeCtx } from "../helpers/mapping-context";

// A minimal, valid export row; override per case.
function exportRow(over: Partial<SignExportRow> = {}): SignExportRow {
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

function roundtrip(
  rows: SignExportRow[],
  ctxOpts: Parameters<typeof makeCtx>[0] = {},
) {
  return buildPreview(parseCsv(signRowsToCsv(rows)), makeCtx(ctxOpts));
}

describe("CSV export → import round-trip", () => {
  it("a clean row survives intact and validates", () => {
    const preview = roundtrip([exportRow()]);
    expect(preview.counts.valid).toBe(1);
    const d = preview.rows[0].data;
    expect(d.itemId).toBe("M-001");
    expect(d.signText).toBe("Aerospace Village");
    expect(d.size).toBe("22x28");
    expect(d.needsEasel).toBe(true);
  });

  it("does not burn the formula-injection guard into signText (#92)", () => {
    // Export prefixes a guard quote to "+1 BADGE PICKUP" so a spreadsheet won't
    // treat it as a formula; import must strip it, not store "'+1 BADGE PICKUP".
    const preview = roundtrip([exportRow({ signText: "+1 BADGE PICKUP" })]);
    expect(preview.counts.valid).toBe(1);
    expect(preview.rows[0].data.signText).toBe("+1 BADGE PICKUP");
  });

  it("keeps a sign text the user started with an apostrophe + formula char (#202)", () => {
    // The export guard and the import strip used to disagree here: "'=SUM(A1)" was
    // exported verbatim, then the importer read its apostrophe as the guard and
    // stripped it, storing the formula-looking "=SUM(A1)". The guard now escapes
    // the ambiguous case so the round-trip is lossless.
    const preview = roundtrip([exportRow({ signText: "'=SUM(A1)" })]);
    expect(preview.counts.valid).toBe(1);
    expect(preview.rows[0].data.signText).toBe("'=SUM(A1)");
  });

  it("keeps an apostrophe that is not a guard at all ('24 reunion)", () => {
    const preview = roundtrip([exportRow({ signText: "'24 reunion" })]);
    expect(preview.rows[0].data.signText).toBe("'24 reunion");
  });

  it("preserves doubleSided=true via the explicit column (#95)", () => {
    // size carries no "double", so only the Double-Sided column conveys the flag.
    const preview = roundtrip([exportRow({ doubleSided: true, size: "22x28" })]);
    expect(preview.rows[0].data.doubleSided).toBe(true);
  });

  it("explicit Double-Sided=No survives even when the size says Double (#95)", () => {
    // The exported "No" must beat the /double/i size heuristic on re-import.
    const preview = roundtrip([
      exportRow({ doubleSided: false, size: "4'x8' Double" }),
    ]);
    expect(preview.rows[0].data.doubleSided).toBe(false);
  });

  it("preserves back-face text through the Back Text column (double-sided)", () => {
    const preview = roundtrip([
      exportRow({ doubleSided: true, backText: "Exit / Salida" }),
    ]);
    expect(preview.counts.valid).toBe(1);
    expect(preview.rows[0].data.backText).toBe("Exit / Salida");
    // "Back Text" is a recognized column on re-import, never flagged as ignored.
    expect(preview.ignoredHeaders).not.toContain("Back Text");
  });

  it("preserves exactDestination through the Room column with no unknown-column warning", () => {
    const preview = roundtrip([exportRow({ exactDestination: "W320" })]);
    expect(preview.counts.valid).toBe(1);
    expect(preview.rows[0].data.exactDestination).toBe("W320");
    // "Room" is a recognized column on re-import, never flagged as ignored.
    expect(preview.ignoredHeaders).not.toContain("Room");
  });

  it("preserves a tag whose slug differs from slugify(name) (#98)", () => {
    // "meterboard" (stored slug) slugifies from the display name "Meter Board" to
    // "meter-board" — exporting the name would drop it. Exporting the slug survives.
    const preview = roundtrip(
      [exportRow({ tagAssignments: [{ tag: { slug: "meterboard" } }] })],
      { tagSlugs: ["meterboard"] },
    );
    expect(preview.rows[0].tagSlugs).toEqual(["meterboard"]);
  });
});
