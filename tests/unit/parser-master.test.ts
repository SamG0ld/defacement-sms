import { describe, it, expect } from "vitest";

import { buildMasterPreview } from "@/app/(app)/signs/import/_parsers/master";
import { makeCtx } from "../helpers/mapping-context";

// Synthetic master "Events & Spaces Inventory" shape: an ID/Department/Name/Hall/
// Level/Room header, a TOTALS-style row with no Name (skipped), then space rows.
const HEADER = ["ID", "Department", "Name", "Hall", "Level 1,2,3", "Booth/Room #"];

const ctx = makeCtx({
  zones: { "LVCC-H2": 2, "LVCC-NH": 9, "LVCC-L2": 3 },
  tagSlugs: ["village"],
});

describe("buildMasterPreview", () => {
  const preview = buildMasterPreview(
    [
      HEADER,
      ["", "TOTALS", "", "", "", ""], // no Name -> skipped
      ["3144", "Village Department", "Crypto Village", "W2", "Level 1", "601"],
      ["3318", "Workshops", "Workshop", "North Hall", "Level 2", "N253"],
      ["3320", "Workshops", "Workshops OPs", "North Hall", "Level 2", "Diamond 3 & 4"],
    ],
    ctx,
  );

  it("emits one candidate per named space, skipping no-Name rows", () => {
    expect(preview.headerError).toBeNull();
    expect(preview.counts.total).toBe(3);
  });

  it("maps a W# hall to a hall zone and the department to a tag", () => {
    const crypto = preview.rows.find((r) => r.data.signText === "Crypto Village");
    expect(crypto?.data.zoneId).toBe(2); // LVCC-H2
    expect(crypto?.data.itemId).toBe("601"); // room number
    expect(crypto?.tagSlugs).toContain("village");
  });

  it("routes North Hall rooms and Diamond ballrooms to the North zone", () => {
    const workshop = preview.rows.find((r) => r.data.signText === "Workshop");
    const ops = preview.rows.find((r) => r.data.signText === "Workshops OPs");
    expect(workshop?.data.zoneId).toBe(9); // LVCC-NH (room N253), not West L2
    expect(ops?.data.zoneId).toBe(9); // LVCC-NH (Diamond 3 & 4)
  });

  it("reports a header error when the master header is absent", () => {
    const bad = buildMasterPreview([["foo", "bar"]], ctx);
    expect(bad.headerError).toMatch(/master header/i);
  });
});
