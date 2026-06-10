import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { buildPreview } from "@/app/(app)/signs/import/_map";
import { parseCsv } from "@/lib/csv";
import { signTypeFromSize } from "@/lib/print-summary";
import { makeCtx } from "../helpers/mapping-context";

// Guards fixtures/ui-coverage-sample.csv against importer drift. The fixture is a
// hand-built CSV that deliberately exercises every branch of the generic import
// path (valid/duplicate/invalid, zone/tag/slot warnings, every signType bucket,
// the meterboard hardware rule, slot aliases) so it can be used to re-validate
// the import -> list/filters -> export -> inventory UI after blowing away data.
// If any assertion here breaks, the importer changed and the fixture (or the
// re-test playbook) needs updating.

// Mirror prisma/seeds/reference-data.sql so the parse resolves real zones/tags
// (IDs are arbitrary positive ints; only membership matters to buildPreview).
const SEEDED_ZONES = {
  "LVCC-L1": 1,
  "LVCC-L2": 2,
  "LVCC-L3": 3,
  "LVCC-H1": 4,
  "LVCC-H2": 5,
  "LVCC-H3": 6,
  "LVCC-H4": 7,
  "LVCC-NH": 8,
};
const SEEDED_TAGS = [
  "priority", "rotating", "sponsor", "registration", "contest", "village",
  "stage", "wayfinding", "bar", "chillout", "vendor", "party", "workshop",
  "community", "command-map", "flying-sign", "banner", "meterboard", "venue-map",
];

function loadFixture() {
  const csv = readFileSync(
    join(process.cwd(), "fixtures", "ui-coverage-sample.csv"),
    "utf8",
  );
  const ctx = makeCtx({ zones: SEEDED_ZONES, tagSlugs: SEEDED_TAGS });
  return buildPreview(parseCsv(csv), ctx);
}

describe("ui-coverage-sample.csv fixture", () => {
  const preview = loadFixture();
  const byItem = (id: string, text: string) =>
    preview.rows.find((r) => r.data.itemId === id && r.data.signText === text);

  it("parses with no header error and the expected valid/duplicate/invalid split", () => {
    expect(preview.headerError).toBeNull();
    expect(preview.counts).toEqual({
      valid: 13,
      duplicate: 1, // the second M-204 "Contest Stage"
      invalid: 2, // missing sign text + missing item id
      total: 16,
    });
  });

  it("surfaces the unmapped 'Requestor' header in ignoredHeaders", () => {
    expect(preview.ignoredHeaders).toContain("Requestor");
    expect(preview.mappedColumns).toEqual(
      expect.arrayContaining([
        "itemId", "signText", "signType", "size", "quantity",
        "placementArea", "needsEasel", "zone", "tags", "deploymentSlot", "notes",
      ]),
    );
  });

  it("flags the intentionally invalid rows with the right reasons", () => {
    const invalid = preview.rows.filter((r) => r.status === "invalid");
    expect(invalid).toHaveLength(2);
    expect(invalid.map((r) => r.reason).join(" | ")).toMatch(/sign text/i);
    expect(invalid.map((r) => r.reason).join(" | ")).toMatch(/item id/i);
  });

  it("marks the exact in-file duplicate", () => {
    const dups = preview.rows.filter((r) => r.status === "duplicate");
    expect(dups).toHaveLength(1);
    expect(dups[0].data.itemId).toBe("M-204");
  });

  it("emits unknown-zone, unknown-tag, and unrecognized-slot warnings", () => {
    const bogus = byItem("M-212", "Bogus Zone Test");
    expect(bogus?.warnings.some((w) => /unknown zone/i.test(w))).toBe(true);
    expect(bogus?.warnings.some((w) => /unknown tag/i.test(w))).toBe(true);

    const badSlot = byItem("M-213", "Unrecognized Slot Test");
    expect(badSlot?.warnings.some((w) => /unrecognized slot/i.test(w))).toBe(true);
    expect(badSlot?.data.deploymentSlot).toBeNull();
  });

  it("normalizes slot aliases (Weds AM -> WED_AM, Thurs PM -> THU_PM)", () => {
    expect(byItem("M-210", "Sponsor Backdrop")?.data.deploymentSlot).toBe("WED_AM");
    expect(byItem("M-211", "Workshop Wayfinding")?.data.deploymentSlot).toBe("THU_PM");
  });

  it("routes the North Hall rows to LVCC-NH (zone id 8)", () => {
    expect(byItem("M-205", "Diamond Ballroom Welcome")?.data.zoneId).toBe(8);
    expect(byItem("M-211", "Workshop Wayfinding")?.data.zoneId).toBe(8);
  });

  it("covers every signType bucket via size inference plus an explicit override", () => {
    // Inferred (Type column left blank -> signTypeFromSize)
    expect(byItem("M-201", "Welcome to DEF CON")?.data.signType).toBe("Meterboard (4'x8')");
    expect(byItem("M-202", "Talks Track 1")?.data.signType).toBe('22"x28"');
    expect(byItem("M-204", "Contest Stage")?.data.signType).toBe('24"x36"');
    expect(byItem("M-205", "Diamond Ballroom Welcome")?.data.signType).toBe("Banner");
    expect(byItem("M-206", "Flying Sign Vendor Hall")?.data.signType).toBe("Socks");
    expect(byItem("M-207", "Outdoor Marquee")?.data.signType).toBe("8'x20'");
    expect(byItem("M-208", "Chillout Lounge")?.data.signType).toBe("Sign"); // odd-size fallback
    // Explicit override beats inference
    expect(byItem("M-203", "Registration This Way")?.data.signType).toBe("Directional");
    // Sanity: the fixture's inferred types match the live classifier
    expect(signTypeFromSize("4'x8' Coroplast Double-Sided")).toBe("Meterboard (4'x8')");
  });

  it("sets doubleSided and needs-hardware drivers (easel + meterboard size)", () => {
    expect(byItem("M-201", "Welcome to DEF CON")?.data.doubleSided).toBe(true);
    expect(byItem("M-202", "Talks Track 1")?.data.needsEasel).toBe(true); // easel column
    expect(byItem("M-201", "Welcome to DEF CON")?.data.needsEasel).toBe(false); // hardware via size, not easel
  });
});
