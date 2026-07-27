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

// A blank Map# row gets a synthetic id derived from its text + placement so a
// re-import of an edited sheet still dedupes. Two genuinely distinct rows can share
// that content though, and an identical id used to make the second look like a
// re-import of the first — silently dropping a real sign from the print run (#223).
describe("buildSignSheetPreview — blank Map# synthetic-id collisions", () => {
  const collided = buildSignSheetPreview(
    rowsWith(
      ['22" x 28"', "", "", "", "", "", "", ""], // material section
      ["", "Restrooms", "", "1", "n", "Hall 1", "", ""], // blank Map#
      ["", "Restrooms", "", "1", "n", "Hall 1", "", ""], // same text + placement
      ["", "Restrooms", "", "1", "n", "Hall 1", "", ""], // and a third
    ),
    ctx,
  );

  it("imports every colliding row instead of dropping the later ones as duplicates", () => {
    expect(collided.counts.valid).toBe(3);
    expect(collided.counts.duplicate).toBe(0);
  });

  it("gives the later rows distinct ids and leaves the first one stable", () => {
    const ids = collided.rows.map((r) => r.data.itemId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("DC33-restrooms-hall-1");
    expect(ids[1]).toBe("DC33-restrooms-hall-1-r2");
    expect(ids[2]).toBe("DC33-restrooms-hall-1-r3");
  });

  it("warns on each suffixed row, naming the line it collided with", () => {
    expect(collided.rows[0].warnings).toEqual([]);
    expect(collided.rows[1].warnings.some((w) => /line 3/.test(w))).toBe(true);
    expect(collided.rows[2].warnings.some((w) => /line 3/.test(w))).toBe(true);
  });

  it("reports the collisions as a preview notice", () => {
    expect(collided.notices?.some((n) => /blank Map#/i.test(n))).toBe(true);
  });

  it("keeps the id of a lone blank-Map# row unsuffixed (re-import stability)", () => {
    const once = buildSignSheetPreview(
      rowsWith(
        ['22" x 28"', "", "", "", "", "", "", ""],
        ["", "Restrooms", "", "1", "n", "Hall 1", "", ""],
      ),
      ctx,
    );
    expect(once.rows[0].data.itemId).toBe("DC33-restrooms-hall-1");
    expect(once.rows[0].warnings).toEqual([]);
    expect(once.notices ?? []).not.toContainEqual(
      expect.stringMatching(/blank Map#/i),
    );
  });

  it("does not let a row's own id land on an already-suffixed one", () => {
    // Line 5's content slugifies to exactly the id line 4 was given. Matching only on
    // the unsuffixed base would hand it that same id and drop it as a duplicate —
    // the very failure this fix exists to remove.
    const nested = buildSignSheetPreview(
      rowsWith(
        ['22" x 28"', "", "", "", "", "", "", ""],
        ["", "Restrooms", "", "1", "n", "Hall 1", "", ""], // line 3
        ["", "Restrooms", "", "1", "n", "Hall 1", "", ""], // line 4 -> ...-r2
        ["", "Restrooms", "", "1", "n", "Hall 1 r2", "", ""], // line 5 -> base == line 4's id
      ),
      ctx,
    );
    const ids = nested.rows.map((r) => r.data.itemId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).not.toBe(ids[1]);
    expect(nested.counts.duplicate).toBe(0);
    expect(nested.rows[2].warnings.some((w) => /line 4/.test(w))).toBe(true);
  });

  it("never touches rows that carry a real Map#", () => {
    const labelled = buildSignSheetPreview(
      rowsWith(
        ['22" x 28"', "", "", "", "", "", "", ""],
        ["P1", "Restrooms", "", "1", "n", "Hall 1", "", ""],
        ["P2", "Restrooms", "", "1", "n", "Hall 1", "", ""],
      ),
      ctx,
    );
    expect(labelled.rows.map((r) => r.data.itemId)).toEqual(["P1", "P2"]);
    expect(labelled.rows.every((r) => r.warnings.length === 0)).toBe(true);
  });
});
