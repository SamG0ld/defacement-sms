import { describe, it, expect } from "vitest";

import { buildSignSheetPreview } from "@/app/(app)/signs/import/_parsers/signSheet";
import { makeCtx } from "../helpers/mapping-context";

// Synthetic DC33 sign-sheet shape: a deploy-matrix column, material/floor/category
// section rows (no Sign Text), then sign rows.
const HEADER = [
  "Map#",
  "Sign Text",
  "Size",
  "Qty",
  "Easel",
  "Location",
  "Notes",
  "DEPLOY FRI (8/8) 6pm",
];

const ctx = makeCtx({
  zones: { "LVCC-H1": 1, "LVCC-NH": 9, "LVCC-L2": 3 },
  tagSlugs: ["village"],
});

function rowsWith(...dataRows: string[][]) {
  return [HEADER, ...dataRows];
}

describe("buildSignSheetPreview", () => {
  it("skips section rows, inherits material/floor/tag, parses the deploy matrix", () => {
    const preview = buildSignSheetPreview(
      rowsWith(
        ['24" x 36"', "", "", "", "", "", "", ""], // material section
        ["Hall 1", "", "", "", "", "", "", ""], // floor section -> zone
        ["Villages", "", "", "", "", "", "", ""], // category section -> tag
        ["", "Crypto Village", "", "2", "y", "", "", "X"], // sign (blank Map#)
      ),
      ctx,
    );

    expect(preview.headerError).toBeNull();
    expect(preview.counts.total).toBe(1); // only the sign row
    const r = preview.rows[0];
    expect(r.data.signText).toBe("Crypto Village");
    expect(r.data.size).toBe('24" x 36"'); // inherited from material section
    expect(r.data.quantity).toBe(2);
    expect(r.data.needsEasel).toBe(true);
    expect(r.data.deploymentSlot).toBe("FRI_PM"); // from the X in the deploy column
    expect(r.data.deployByDate?.toISOString()).toBe("2025-08-08T00:00:00.000Z"); // (8/8) from the header
    expect(r.data.zoneId).toBe(1); // LVCC-H1 from the floor section
    expect(r.data.itemId).toMatch(/^DC33-crypto-village/); // content-based auto-id
    expect(r.tagSlugs).toContain("village");
  });

  it("routes a North Hall location to the North zone, not West Level 2", () => {
    const preview = buildSignSheetPreview(
      rowsWith(
        ['22" x 28"', "", "", "", "", "", "", ""],
        ["N260", "Movie Night", "", "1", "n", "L2 - N260", "", ""],
      ),
      ctx,
    );
    expect(preview.rows[0].data.zoneId).toBe(9); // LVCC-NH, not LVCC-L2 (3)
  });

  it("parses an event-time window from the Notes column", () => {
    const preview = buildSignSheetPreview(
      rowsWith([
        "P1",
        "Pool Party",
        '22" x 28"',
        "1",
        "n",
        "",
        "Friday (8/8) 19:00:00 - 21:00:00",
        "",
      ]),
      ctx,
    );
    expect(preview.rows[0].data.eventStart?.toISOString()).toBe(
      "2025-08-09T02:00:00.000Z",
    );
    expect(preview.rows[0].data.eventEnd?.toISOString()).toBe(
      "2025-08-09T04:00:00.000Z",
    );
  });

  it("reports a header error when the sign-sheet header is absent", () => {
    const preview = buildSignSheetPreview([["foo", "bar"]], ctx);
    expect(preview.headerError).toMatch(/sign-sheet header/i);
  });
});
