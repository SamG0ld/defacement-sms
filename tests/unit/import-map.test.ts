import { describe, it, expect } from "vitest";

import {
  buildPreview,
  categorizeRows,
  cell,
  clampQuantity,
  isTruthy,
  mapHeaders,
  normalizeSlot,
  parseDoubleSided,
  resolveTags,
  resolveTagSlugs,
  resolveZone,
  sheetIdentityKey,
  signDedupKey,
  slugify,
  tooManyRows,
  MAX_IMPORT_ROWS,
  type RowDraft,
  type SignData,
} from "@/app/(app)/signs/import/_map";
import { makeCtx } from "../helpers/mapping-context";

describe("mapHeaders", () => {
  it("maps known aliases to column indexes", () => {
    const map = mapHeaders(["Map#", "Sign Text", "Qty", "Location"]);
    expect(map).toEqual({
      itemId: 0,
      signText: 1,
      quantity: 2,
      placementArea: 3,
    });
  });

  it("maps the Room column (and its aliases) to exactDestination", () => {
    // The export emits "Room"; hand-authored sheets may say "Room Number" or
    // "Exact Destination". All bind to exactDestination and round-trip.
    expect(mapHeaders(["Room"]).exactDestination).toBe(0);
    expect(mapHeaders(["Room Number"]).exactDestination).toBe(0);
    expect(mapHeaders(["Exact Destination"]).exactDestination).toBe(0);
  });
});

describe("small field helpers", () => {
  it("slugify", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  A & B  ")).toBe("a-b");
  });

  it("normalizeSlot", () => {
    expect(normalizeSlot("Weds AM")).toBe("WED_AM");
    expect(normalizeSlot("THURS_PM")).toBe("THU_PM");
    expect(normalizeSlot("tue am")).toBe("TUES_AM");
    expect(normalizeSlot("nonsense")).toBeNull();
  });

  it("cell trims and tolerates undefined index", () => {
    expect(cell([" x "], 0)).toBe("x");
    expect(cell(["a", "b"], 1)).toBe("b");
    expect(cell(["a"], undefined)).toBe("");
  });

  it("clampQuantity coerces into [1, 999]", () => {
    expect(clampQuantity("5")).toBe(5);
    expect(clampQuantity("0")).toBe(1);
    expect(clampQuantity("9999")).toBe(999);
    expect(clampQuantity("abc")).toBe(1);
    expect(clampQuantity("")).toBe(1);
  });

  it("isTruthy", () => {
    expect(isTruthy("yes")).toBe(true);
    expect(isTruthy("X")).toBe(true);
    expect(isTruthy("no")).toBe(false);
    expect(isTruthy("")).toBe(false);
  });

  it("parseDoubleSided: explicit column wins, else size heuristic", () => {
    expect(parseDoubleSided("Yes", "22x28")).toBe(true); // explicit, non-double size
    expect(parseDoubleSided("No", "4'x8' Double")).toBe(false); // explicit No beats size
    expect(parseDoubleSided("", "4'x8' Double")).toBe(true); // fall back to size
    expect(parseDoubleSided("", "22x28")).toBe(false);
  });
});

describe("tooManyRows", () => {
  it("caps above MAX_IMPORT_ROWS", () => {
    expect(tooManyRows(MAX_IMPORT_ROWS)).toBeNull();
    const over = tooManyRows(MAX_IMPORT_ROWS + 1);
    expect(over?.headerError).toMatch(/too many rows/i);
  });
});

describe("categorizeRows", () => {
  const base: SignData = {
    itemId: "A",
    signText: "Sign A",
    sheetName: null,
    signType: "Sign",
    size: "22x28",
    quantity: 1,
    doubleSided: false,
    needsEasel: false,
    category: "easel_sign",
    printable: true,
    placementArea: null,
    exactDestination: null,
    notes: null,
    deploymentSlot: null,
    zoneId: null,
  };
  const draft = (data: SignData, line: number): RowDraft => ({
    line,
    data,
    tagSlugs: [],
    warnings: [],
  });

  it("marks valid / invalid / duplicate (DB and in-file)", () => {
    const drafts: RowDraft[] = [
      draft(base, 1), // valid
      draft({ ...base, signText: "" }, 2), // invalid (schema)
      draft({ ...base, itemId: "B", signText: "Sign B" }, 3), // dup vs DB
      draft(base, 4), // dup of row 1 within the file
    ];
    const ctx = makeCtx({
      existingKeys: [signDedupKey("B", "Sign B", "22x28")],
    });
    const preview = categorizeRows(drafts, ctx, {
      mappedColumns: [],
      ignoredHeaders: [],
    });

    expect(preview.counts).toEqual({
      valid: 1,
      invalid: 1,
      duplicate: 2,
      readd: 0,
      total: 4,
    });
    expect(preview.rows[1].status).toBe("invalid");
    expect(preview.rows[1].reason).toMatch(/sign text/i);
    expect(preview.rows[2].status).toBe("duplicate");
    expect(preview.rows[3].status).toBe("duplicate");
  });

  // #265: #263 made "archived tombstone + live twin" the intended end state of
  // remove-then-re-add, and the DB permits it — but the preview called the re-add
  // a DUPLICATE and hid it behind the likely-duplicate opt-in, so a lead who
  // trusted the label declined it and the sign was never produced.
  describe("re-add of a removed sign (#265)", () => {
    it("matches only a tombstone → readd, not duplicate", () => {
      const ctx = makeCtx({
        archivedKeys: [signDedupKey("A", "Sign A", "22x28")],
      });
      const preview = categorizeRows([draft(base, 1)], ctx, {
        mappedColumns: [],
        ignoredHeaders: [],
      });

      expect(preview.rows[0].status).toBe("readd");
      expect(preview.rows[0].reason).toMatch(/removed from the record/i);
      expect(preview.counts).toEqual({
        valid: 0,
        invalid: 0,
        duplicate: 0,
        readd: 1,
        total: 1,
      });
    });

    it("a LIVE row wins over a tombstone with the same key → duplicate", () => {
      // The live twin is what a re-import would actually collide with, so the
      // duplicate treatment (and its opt-in) has to stay.
      const key = signDedupKey("A", "Sign A", "22x28");
      const ctx = makeCtx({ existingKeys: [key], archivedKeys: [key] });
      const preview = categorizeRows([draft(base, 1)], ctx, {
        mappedColumns: [],
        ignoredHeaders: [],
      });
      expect(preview.rows[0].status).toBe("duplicate");
    });

    it("demotes to duplicate when a LIVE row already holds the sheet identity", () => {
      // The dedup key (room + text + size) and the DB's uniqueness identity
      // (room + sheetName + category) diverge whenever the sheet overrides a
      // space's printed text. A re-add imports unattended, so if the DB would
      // reject it the whole one-transaction import dies — it has to stay a
      // duplicate (skipped by default, opt-in still available).
      const row: SignData = { ...base, sheetName: "Payment Village" };
      const ctx = makeCtx({
        archivedKeys: [signDedupKey("A", "Sign A", "22x28")],
        liveSheetIdentities: [
          sheetIdentityKey("A", "Payment Village", "easel_sign"),
        ],
      });
      const preview = categorizeRows([draft(row, 1)], ctx, {
        mappedColumns: [],
        ignoredHeaders: [],
      });
      expect(preview.rows[0].status).toBe("duplicate");
      expect(preview.rows[0].reason).toMatch(/still in the record/i);
      expect(preview.counts.readd).toBe(0);
    });

    it("a live sheet identity on a DIFFERENT category does not block the re-add", () => {
      const row: SignData = { ...base, sheetName: "Payment Village" };
      const ctx = makeCtx({
        archivedKeys: [signDedupKey("A", "Sign A", "22x28")],
        liveSheetIdentities: [sheetIdentityKey("A", "Payment Village", "socks")],
      });
      const preview = categorizeRows([draft(row, 1)], ctx, {
        mappedColumns: [],
        ignoredHeaders: [],
      });
      expect(preview.rows[0].status).toBe("readd");
    });

    it("a second copy of a re-add WITHIN the file is still a duplicate", () => {
      const ctx = makeCtx({
        archivedKeys: [signDedupKey("A", "Sign A", "22x28")],
      });
      const preview = categorizeRows([draft(base, 1), draft(base, 2)], ctx, {
        mappedColumns: [],
        ignoredHeaders: [],
      });
      expect(preview.rows[0].status).toBe("readd");
      expect(preview.rows[1].status).toBe("duplicate");
    });
  });

  it("dedups a variant room-code spelling of the same booth (normalized key)", () => {
    // DB already has the booth under one spelling; importing the other spelling of
    // the SAME booth (same text + size) must dedupe, not create a twin.
    const ctx = makeCtx({
      existingKeys: [signDedupKey("W204, W205", "Payment Village", "4'x8' Double")],
    });
    const drafts: RowDraft[] = [
      draft({ ...base, itemId: "W204-W205", signText: "Payment Village", size: "4'x8' Double" }, 1),
    ];
    const preview = categorizeRows(drafts, ctx, {
      mappedColumns: [],
      ignoredHeaders: [],
    });
    expect(preview.rows[0].status).toBe("duplicate");
  });

  it("dedup key includes size: same room+text, different size both survive", () => {
    const drafts: RowDraft[] = [
      draft({ ...base, itemId: "W203", signText: "Press", size: "22x28" }, 1),
      draft({ ...base, itemId: "W203", signText: "Press", size: "Socks", category: "socks" }, 2),
    ];
    const preview = categorizeRows(drafts, makeCtx(), {
      mappedColumns: [],
      ignoredHeaders: [],
    });
    expect(preview.counts.valid).toBe(2);
    expect(preview.counts.duplicate).toBe(0);
  });

  it("surfaces section-level notices when provided", () => {
    const preview = categorizeRows([draft(base, 1)], makeCtx(), {
      mappedColumns: [],
      ignoredHeaders: [],
      notices: ["heads up"],
    });
    expect(preview.notices).toEqual(["heads up"]);
  });
});

describe("resolve helpers", () => {
  const ctx = makeCtx({
    zones: { "LVCC-L1": 1 },
    tagSlugs: ["village", "contest"],
  });

  it("resolveZone maps known codes and warns on unknown", () => {
    const warnings: string[] = [];
    expect(resolveZone("lvcc-l1", ctx, warnings)).toBe(1);
    expect(resolveZone("", ctx, warnings)).toBeNull();
    expect(resolveZone("NOPE", ctx, warnings)).toBeNull();
    expect(warnings.some((w) => /unknown zone/i.test(w))).toBe(true);
  });

  it("resolveTags splits a free-text cell and keeps known slugs", () => {
    const warnings: string[] = [];
    expect(resolveTags("Village, Contest", ctx, warnings)).toEqual([
      "village",
      "contest",
    ]);
    expect(resolveTags("Village; Ghost", ctx, warnings)).toEqual(["village"]);
    expect(warnings.some((w) => /unknown tag/i.test(w))).toBe(true);
    expect(resolveTags("", ctx, warnings)).toEqual([]);
  });

  it("resolveTagSlugs filters to known slugs", () => {
    const warnings: string[] = [];
    expect(resolveTagSlugs(["village", "ghost"], ctx, warnings)).toEqual([
      "village",
    ]);
  });

  it("resolves a hand-typed tag display name to its stored slug across hyphenation (#137)", () => {
    // In a hand-authored CSV a person may type the tag display name ("Meter
    // Board") rather than its slug. That slugifies to "meter-board", whose stored
    // slug collapses the space ("meterboard"); it must still resolve, not warn.
    // (App-exported files already emit slugs and round-trip exactly — see #98.)
    const mb = makeCtx({ tagSlugs: ["meterboard"] });
    const warnings: string[] = [];
    expect(resolveTags("Meter Board", mb, warnings)).toEqual(["meterboard"]);
    expect(warnings).toEqual([]);
  });
});

describe("buildPreview (generic CSV)", () => {
  const header = ["Map#", "Sign Text", "Size", "Qty", "Zone", "Tags", "Deploy"];
  const ctx = makeCtx({ zones: { "LVCC-L1": 1 }, tagSlugs: ["village"] });

  it("errors when required columns are missing", () => {
    const preview = buildPreview([["Foo", "Bar"], ["1", "2"]], ctx);
    expect(preview.headerError).toMatch(/missing required column/i);
  });

  it("errors on an empty file", () => {
    expect(buildPreview([], ctx).headerError).toMatch(/empty/i);
  });

  it("maps rows, applies defaults, resolves zone/tags/slot", () => {
    const preview = buildPreview(
      [header, ["A1", "Sign One", "", "2", "LVCC-L1", "village", "FRI_PM"]],
      ctx,
    );
    expect(preview.headerError).toBeNull();
    expect(preview.counts.valid).toBe(1);
    const d = preview.rows[0].data;
    expect(d.size).toBe("Unspecified"); // default when blank
    expect(d.quantity).toBe(2);
    expect(d.zoneId).toBe(1);
    expect(d.deploymentSlot).toBe("FRI_PM");
    expect(preview.rows[0].tagSlugs).toEqual(["village"]);
  });

  it("skips fully blank rows", () => {
    const preview = buildPreview(
      [
        header,
        ["", "", "", "", "", "", ""],
        ["A2", "Sign Two", "", "1", "", "", ""],
      ],
      ctx,
    );
    expect(preview.counts.total).toBe(1);
  });

  it("does not bind itemId from a bare 'id' header (#96)", () => {
    // A column literally named "id" must not satisfy the required Item ID — it's
    // excluded from the alias list to stay consistent with the generator parser.
    const preview = buildPreview([["id", "Sign Text"], ["X1", "Hello"]], ctx);
    expect(preview.headerError).toMatch(/missing required column/i);
  });

  it("reads an explicit Double-Sided column over the size heuristic (#95)", () => {
    const h = ["Map#", "Sign Text", "Size", "Double-Sided"];
    const yes = buildPreview([h, ["A1", "Sign", "22x28", "Yes"]], ctx);
    expect(yes.rows[0].data.doubleSided).toBe(true); // non-double size, explicit Yes
    const no = buildPreview([h, ["A2", "Sign", "4'x8' Double", "No"]], ctx);
    expect(no.rows[0].data.doubleSided).toBe(false); // explicit No beats "Double" size
  });

  it("maps a Room cell into exactDestination; blank stays null", () => {
    const h = ["Item ID", "Sign Text", "Room"];
    const withRoom = buildPreview([h, ["W320", "Aerospace", "W320"]], ctx);
    expect(withRoom.rows[0].data.exactDestination).toBe("W320");
    const blank = buildPreview([h, ["W321", "Biohacking", ""]], ctx);
    expect(blank.rows[0].data.exactDestination).toBeNull();
    // "Room" is a recognized column, not an unknown/ignored header.
    expect(withRoom.ignoredHeaders).not.toContain("Room");
  });

  it("imports a hand-authored row: Double-Sided=Yes + 'Meter Board' display-name tag (#137)", () => {
    // A hand-authored row with an explicit "Double-Sided" column and a tag typed
    // as its display NAME must import with doubleSided=true and the stored
    // "meterboard" slug, not lose either to size re-derivation or a hyphenation
    // mismatch. (App exports emit slugs directly — see #98 — so this covers the
    // human-edited/generic CSV case, not the app's own export.)
    const mb = makeCtx({ tagSlugs: ["meterboard"] });
    const h = ["Item ID", "Sign Text", "Size", "Double-Sided", "Tags"];
    const preview = buildPreview(
      [h, ["A1", "Room Label", "22x28", "Yes", "Meter Board"]],
      mb,
    );
    expect(preview.counts.valid).toBe(1);
    expect(preview.rows[0].data.doubleSided).toBe(true);
    expect(preview.rows[0].tagSlugs).toEqual(["meterboard"]);
    expect(preview.rows[0].warnings).toEqual([]);
  });
});
