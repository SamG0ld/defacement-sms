import { describe, it, expect } from "vitest";

import {
  diffSnapshots,
  identityOf,
  isSockCategory,
  normalizeKeyPart,
  reconcile,
  type AppSign,
  type ReconcileSnapshot,
  type SheetItem,
} from "@/lib/reconcile";

function snap(signText: string): ReconcileSnapshot {
  return { signText };
}

// A sheet item. sheetName is the identity anchor; signText is the (reconciled)
// printed text — equal to sheetName unless a case sets an override.
function sheetItem(
  itemId: string,
  sheetName: string,
  opts: { signText?: string; isSock?: boolean; deptTag?: string | null; line?: number } = {},
): SheetItem {
  const signText = opts.signText ?? sheetName;
  const isSock = opts.isSock ?? false;
  return {
    identity: identityOf(itemId, sheetName, isSock),
    line: opts.line ?? 1,
    itemId,
    sheetName,
    signText,
    isSock,
    deptTag: opts.deptTag ?? null,
    snapshot: snap(signText),
  };
}

function appSign(
  id: number,
  itemId: string,
  sheetName: string,
  opts: { signText?: string; isSock?: boolean; deptTag?: string | null } = {},
): AppSign {
  const signText = opts.signText ?? sheetName;
  const isSock = opts.isSock ?? false;
  return {
    id,
    identity: identityOf(itemId, sheetName, isSock),
    itemId,
    sheetName,
    signText,
    isSock,
    deptTag: opts.deptTag ?? null,
    snapshot: snap(signText),
  };
}

describe("identity helpers", () => {
  it("normalizeKeyPart collapses whitespace + case", () => {
    expect(normalizeKeyPart("  W317-W319 ")).toBe("w317-w319");
    expect(normalizeKeyPart("Level  2")).toBe("level 2");
  });

  it("isSockCategory only matches socks", () => {
    expect(isSockCategory("socks")).toBe(true);
    expect(isSockCategory("easel_sign")).toBe(false);
  });

  it("identity keys on room + sheetName (not signText); sock is distinct", () => {
    // Same room + sheetName, different signText (an override) -> same identity.
    expect(identityOf("W311", "Friday Reg - South", false)).toBe(
      identityOf("w311 ", "friday reg - south", false),
    );
    expect(identityOf("W311", "Cloud Village", true)).not.toBe(
      identityOf("W311", "Cloud Village", false),
    );
  });

  it("identity collapses variant room-code spellings (prevents the dupe at source)", () => {
    // "W204, W205" and "W204-W205" are the same booth — one identity, so a re-sync
    // matches instead of adding a twin. (The prod dupes came from these not matching.)
    expect(identityOf("W204, W205", "Payment Village", false)).toBe(
      identityOf("W204-W205", "Payment Village", false),
    );
    expect(identityOf("W219 -W220", "Voting Village", true)).toBe(
      identityOf("W219, W220", "Voting Village", true),
    );
  });
});

describe("diffSnapshots", () => {
  it("returns [] for identical signText", () => {
    expect(diffSnapshots(snap("Registration"), snap("Registration"))).toEqual([]);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(diffSnapshots(snap("Reg"), snap("  Reg "))).toEqual([]);
  });

  it("reports from(app)->to(sheet) when the printed text differs", () => {
    expect(
      diffSnapshots(snap("Friday Reg - South"), snap("Registration")),
    ).toEqual([{ field: "signText", from: "Friday Reg - South", to: "Registration" }]);
  });
});

describe("reconcile", () => {
  it("ADD: a sheet row with no app match", () => {
    const res = reconcile([sheetItem("W999", "New Village")], []);
    expect(res.counts).toMatchObject({ add: 1, change: 0, remove: 0 });
    expect(res.adds[0].sheet.sheetName).toBe("New Village");
  });

  it("no-op: identical sheet + app row counts as unchanged, no change emitted", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village")],
      [appSign(1, "W311", "Cloud Village")],
    );
    expect(res.counts).toMatchObject({
      add: 0,
      change: 0,
      remove: 0,
      unchanged: 1,
    });
  });

  it("CHANGE: a signText override on a matched sign (matched by sheetName)", () => {
    const res = reconcile(
      [sheetItem("W1", "Friday Reg - South", { signText: "Registration" })],
      [appSign(7, "W1", "Friday Reg - South", { signText: "Friday Reg - South" })],
    );
    expect(res.counts).toMatchObject({ add: 0, change: 1, remove: 0 });
    expect(res.changes[0].signId).toBe(7);
    expect(res.changes[0].fields).toEqual([
      { field: "signText", from: "Friday Reg - South", to: "Registration" },
    ]);
  });

  it("regression: a signText override is a CHANGE, not DELETE+ADD (identity = sheetName)", () => {
    // The crux of the M18 design: keying identity on sheetName (not signText) means
    // a "text should be X" override never orphans the sign's app state.
    const res = reconcile(
      [sheetItem("W234", "DISPATCH & LOST & FOUND", { signText: "LOST & FOUND" })],
      [appSign(9, "W234", "DISPATCH & LOST & FOUND")],
    );
    expect(res.counts).toMatchObject({ add: 0, remove: 0, change: 1 });
    expect(res.changes[0].signId).toBe(9);
  });

  it("REMOVE: a master-sheet sign absent from the sheet is flagged (never deleted here)", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village")],
      [
        appSign(1, "W311", "Cloud Village"),
        appSign(2, "W500", "Retired Village"),
      ],
    );
    expect(res.counts).toMatchObject({ add: 0, change: 0, remove: 1 });
    expect(res.removes[0].signId).toBe(2);
  });

  it("DEPT CHANGE: a matched sign whose department moved is informational, not a change", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village", { deptTag: "village" })],
      [appSign(3, "W311", "Cloud Village", { deptTag: "contest" })],
    );
    // Same signText -> unchanged; the dept move surfaces only in the info bucket.
    expect(res.counts).toMatchObject({
      change: 0,
      unchanged: 1,
      deptChange: 1,
    });
    expect(res.deptChanges[0]).toMatchObject({
      signId: 3,
      from: "contest",
      to: "village",
    });
  });

  it("a pair can carry both a signText change and a dept-change flag", () => {
    const res = reconcile(
      [sheetItem("W1", "Reg Desk", { signText: "Registration", deptTag: "registration" })],
      [appSign(5, "W1", "Reg Desk", { signText: "Reg Desk", deptTag: "contest" })],
    );
    expect(res.counts).toMatchObject({ change: 1, deptChange: 1 });
    expect(res.changes[0].signId).toBe(5);
    expect(res.deptChanges[0].signId).toBe(5);
  });

  it("no dept-change flag when the department is unchanged", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village", { deptTag: "village" })],
      [appSign(1, "W311", "Cloud Village", { deptTag: "village" })],
    );
    expect(res.counts.deptChange).toBe(0);
  });

  it("sock gained -> ADD; the primary alongside it is unchanged", () => {
    const res = reconcile(
      [
        sheetItem("W311", "Cloud Village"),
        sheetItem("W311", "Cloud Village", { isSock: true }),
      ],
      [appSign(1, "W311", "Cloud Village")],
    );
    expect(res.counts).toMatchObject({ add: 1, change: 0, remove: 0, unchanged: 1 });
    expect(res.adds[0].sheet.isSock).toBe(true);
  });

  it("sock lost -> REMOVE the sock only, primary untouched", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village")],
      [
        appSign(1, "W311", "Cloud Village"),
        appSign(2, "W311", "Cloud Village", { isSock: true }),
      ],
    );
    expect(res.counts).toMatchObject({ add: 0, change: 0, remove: 1, unchanged: 1 });
    expect(res.removes[0].signId).toBe(2);
    expect(res.removes[0].app.isSock).toBe(true);
  });

  it("AMBIGUOUS: an identity matching two app signs is flagged, not changed", () => {
    const res = reconcile(
      [sheetItem("W311", "Cloud Village", { signText: "New Text" })],
      [
        appSign(1, "W311", "Cloud Village"),
        appSign(2, "W311", "Cloud Village"),
      ],
    );
    expect(res.counts).toMatchObject({ ambiguous: 1, change: 0, add: 0 });
    expect(res.ambiguous[0].signIds).toEqual([1, 2]);
    expect(res.ambiguous[0].sheetName).toBe("Cloud Village");
    // Those two are matched (identity present in sheet), so not flagged as removes.
    expect(res.counts.remove).toBe(0);
  });

  it("normalization: trailing whitespace + case in the key never fabricate an add/remove", () => {
    // Same printed text on both sides isolates the identity-key normalization: the
    // differently-cased/spaced room + sheetName still match the same sign.
    const res = reconcile(
      [sheetItem("W317-W319 ", "Social Engineering  Community", { signText: "SEC" })],
      [appSign(1, "w317-w319", "social engineering community", { signText: "SEC" })],
    );
    expect(res.counts).toMatchObject({ add: 0, change: 0, remove: 0, unchanged: 1 });
  });
});
