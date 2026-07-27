import { describe, it, expect } from "vitest";

import {
  buildMasterPreview,
  groupMasterRows,
  isExhibitorDept,
} from "@/app/(app)/signs/import/_parsers/master";
import {
  identityOf,
  isSockCategory,
  reconcile,
  type SheetItem,
} from "@/lib/reconcile";
import { departmentTagFromSlugs } from "@/lib/con-config";
import type { ImportPreview, MappedRow } from "@/app/(app)/signs/import/_map";
import { makeCtx } from "../helpers/mapping-context";

// Synthetic master "Events & Spaces Inventory" shape: an ID/Department/Name/Hall/
// Level/Room header, a TOTALS-style row with no Name (skipped), then space rows.
const HEADER = ["ID", "Department", "Name", "Hall", "Level 1,2,3", "Booth/Room #"];

const ctx = makeCtx({
  zones: { "LVCC-H2": 2, "LVCC-NH": 9, "LVCC-L2": 3 },
  tagSlugs: ["village", "workshop"],
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

// SYNTHETIC parser-test rows — these are fake spaces that exist only to exercise
// the parser; they are never written to any database. The DC34 master adds an
// "Is it in the hall?", Goon Lead, Creator Primary/Second, and Floorplan column;
// the parser sizes each space by department and adds a sock to room-based
// village/community spaces. Names are generic test labels, not real spaces.
const H34 = [
  "ID", "Venue", "Sort", "Is it in the hall?", "Department", "Goon Lead",
  "Creator Primary", "Creator Second", "Name", "Hall", "Level 1,2,3",
  "Booth/Room #", "Floorplan",
];

const ctx34 = makeCtx({
  zones: {
    "LVCC-H1": 1, "LVCC-H2": 2, "LVCC-H3": 3, "LVCC-H4": 4,
    "LVCC-L1": 5, "LVCC-L2": 6,
  },
  tagSlugs: ["village", "contest", "community", "stage", "workshop", "nfo"],
});

const dc34 = buildMasterPreview(
  [
    H34,
    // in-hall village -> meterboard, with creators + floorplan folded into notes, no sock
    ["", "LVCC", "", "Y", "Village", "", "alice", "bob", "Village In Hall", "W2", "Level 1", "601", "http://fp/1"],
    // non-hall village -> meterboard primary + a sock
    ["", "LVCC", "", "N", "Village", "", "", "", "Village In Room", "Meeting Room", "Level 2", "W225", ""],
    // contest -> 22x28 easel sign, goon lead folded into notes
    ["", "LVCC", "", "Y", "Contest", "goonx", "", "", "Sample Contest", "W1", "Level 1", "106", ""],
    // creator stage -> single-sided meterboard
    ["", "LVCC", "", "Y", "Creator Stage", "", "", "", "Sample Stage", "W4", "Level 1", "400", ""],
    // non-hall workshop -> not a sock department, so no sock
    ["", "LVCC", "", "N", "Workshop", "", "", "", "Sample Workshop", "Meeting Room", "Level 2", "W260", ""],
    // non-hall community -> also a sock department, gets a sock
    ["", "LVCC", "", "N", "Community", "", "", "", "Community In Room", "Meeting Room", "Level 2", "W230", ""],
    // blank "in the hall?" cell -> treated as in-hall, no sock fabricated
    ["", "LVCC", "", "", "Village", "", "", "", "Village Unflagged", "Meeting Room", "Level 2", "W226", ""],
  ],
  ctx34,
);
const find = (text: string, size?: string) =>
  dc34.rows.find(
    (r) => r.data.signText === text && (size === undefined || r.data.size === size),
  );

describe("buildMasterPreview — DC34 department sizing", () => {
  it("sizes a village as a double-sided 4'x8' meterboard", () => {
    const v = find("Village In Hall");
    expect(v?.data.size).toBe("4'x8' Double");
    expect(v?.data.category).toBe("meterboard");
    expect(v?.data.doubleSided).toBe(true);
    expect(v?.data.needsEasel).toBe(false);
    expect(v?.tagSlugs).toContain("village");
  });

  it("sizes a contest as a 22x28 easel sign", () => {
    const c = find("Sample Contest");
    expect(c?.data.size).toBe("22x28");
    expect(c?.data.category).toBe("easel_sign");
    expect(c?.data.needsEasel).toBe(true);
    expect(c?.tagSlugs).toContain("contest");
  });

  it("sizes a creator stage as a single-sided meterboard", () => {
    const s = find("Sample Stage");
    expect(s?.data.size).toBe("4'x8' Single");
    expect(s?.data.category).toBe("meterboard");
    expect(s?.data.doubleSided).toBe(false);
    expect(s?.tagSlugs).toContain("stage");
  });

  it("folds creators / goon lead / floorplan into notes", () => {
    expect(find("Village In Hall")?.data.notes).toContain("Creators: alice / bob");
    expect(find("Village In Hall")?.data.notes).toContain("Floorplan: http://fp/1");
    expect(find("Sample Contest")?.data.notes).toContain("Goon Lead: goonx");
  });
});

describe("buildMasterPreview — DC34 socks", () => {
  it("adds a sock to a non-hall village (primary meterboard + sock)", () => {
    expect(find("Village In Room", "4'x8' Double")?.data.category).toBe("meterboard");
    const sock = find("Village In Room", "Socks");
    expect(sock?.data.category).toBe("socks");
    expect(sock?.data.notes).toContain("entrance marker");
  });

  it("socks a non-hall community space too", () => {
    expect(find("Community In Room", "Socks")?.data.category).toBe("socks");
  });

  it("does not sock an in-hall village or a non-hall non-village space", () => {
    expect(find("Village In Hall", "Socks")).toBeUndefined(); // in the hall
    expect(find("Sample Workshop", "Socks")).toBeUndefined(); // not a sock department
  });

  it("does not fabricate a sock when the in-hall cell is blank", () => {
    expect(find("Village Unflagged", "Socks")).toBeUndefined();
    expect(find("Village Unflagged", "4'x8' Double")).toBeDefined();
  });

  it("reports the sock count as a notice", () => {
    expect(dc34.notices?.[0]).toMatch(/2 sock entrance-marker/i);
    // 7 named primaries + 2 socks (non-hall village + non-hall community)
    expect(dc34.counts.total).toBe(9);
  });
});

// exactDestination = the raw room (printed bottom-right by the sign art), NOT
// itemId — which has a fallback chain (idVal -> synthetic `M-<slug>`) that must
// never reach the sign face. SYNTHETIC rows.
const roomPreview = buildMasterPreview(
  [
    ["ID", "Department", "Name", "Hall", "Level 1,2,3", "Booth/Room #"],
    ["601", "Village", "Roomed Space", "W2", "Level 1", "601"], // has a room
    ["9999", "Village", "Roomless Space", "W2", "Level 1", ""], // no room; ID present
  ],
  makeCtx({ zones: { "LVCC-H2": 2 }, tagSlugs: ["village"] }),
);
const roomFind = (text: string) =>
  roomPreview.rows.find((r) => r.data.signText === text);

describe("buildMasterPreview — exactDestination (Room)", () => {
  it("sets exactDestination to the room when the space has one", () => {
    expect(roomFind("Roomed Space")?.data.exactDestination).toBe("601");
  });

  it("leaves exactDestination null when there is no room (itemId falls back to the ID)", () => {
    const roomless = roomFind("Roomless Space");
    // itemId falls back to the ID column so the row still has an identity...
    expect(roomless?.data.itemId).toBe("9999");
    // ...but the sign face prints nothing — the internal ID must not leak to it.
    expect(roomless?.data.exactDestination).toBeNull();
  });

  it("a sock inherits the room from its primary", () => {
    // "Village In Room" (non-hall village, room W225) gets a primary + a sock.
    expect(find("Village In Room", "4'x8' Double")?.data.exactDestination).toBe("W225");
    expect(find("Village In Room", "Socks")?.data.exactDestination).toBe("W225");
  });
});

// 24"x36" conference-room departments. DC33 sized Workshops / Registration / A&E
// up to the larger easel sign; the rule follows that precedent. SYNTHETIC rows.
const ctx2436 = makeCtx({ tagSlugs: ["workshop", "registration", "a-e"] });
const big2436Preview = buildMasterPreview(
  [
    ["ID", "Department", "Name", "Hall", "Level 1,2,3", "Booth/Room #"],
    ["", "Workshops", "Sample Workshop Room", "North Hall", "Level 2", "N254"],
    ["", "Registration", "Sample Registration", "W1", "Level 1", "W104"],
    ["", "Arts and Entertainment (A&E)", "Sample A&E", "W1", "Level 1", "W105"],
  ],
  ctx2436,
);
const find2436 = (text: string) =>
  big2436Preview.rows.find((r) => r.data.signText === text);

describe("buildMasterPreview — DC34 24x36 conference-room departments", () => {
  it("sizes workshops at 24x36 (DC33 precedent), not the 22x28 default", () => {
    expect(find2436("Sample Workshop Room")?.data.size).toBe("24x36");
    expect(find2436("Sample Workshop Room")?.data.category).toBe("easel_sign");
    expect(find2436("Sample Workshop Room")?.tagSlugs).toContain("workshop");
  });

  it("sizes registration desks at 24x36", () => {
    expect(find2436("Sample Registration")?.data.size).toBe("24x36");
    expect(find2436("Sample Registration")?.data.category).toBe("easel_sign");
    expect(find2436("Sample Registration")?.tagSlugs).toContain("registration");
  });

  it("sizes A&E at 24x36 and tags it", () => {
    expect(find2436("Sample A&E")?.data.size).toBe("24x36");
    expect(find2436("Sample A&E")?.data.category).toBe("easel_sign");
    expect(find2436("Sample A&E")?.tagSlugs).toContain("a-e");
  });
});

// The live (Nikita) sheet drops the Creator columns and adds an "Additional
// Signage Request" + "Notes" column. SYNTHETIC rows — never written to a DB.
const HNIK = [
  "Is it in the hall?", "Department", "Goon Lead", "Name", "Hall",
  "Level 1,2,3", "Booth/Room #", "Floorplan", "Additional Signage Request", "Notes",
];
const ctxNik = makeCtx({
  zones: { "LVCC-H4": 4, "LVCC-L2": 6 },
  tagSlugs: ["training", "community", "village", "needs-confirmation"],
});
const nik = buildMasterPreview(
  [
    HNIK,
    // "confirm with X" request -> needs-confirmation tag + folded into notes
    ["N", "Training", "", "Training 01", "Meeting Room", "Level 2", "W201", "", "Confirm sign list with seeyew", ""],
    // content request (no "confirm") -> folded into notes, NO needs-confirmation tag
    ["Y", "Community", "", "VETCON", "W4", "Level 1", "1420", "", "Include time of party on sign", "party at 9pm"],
    // "comfirm" typo + a department with no tag -> still flagged needs-confirmation
    ["Y", "Exhibitors", "", "Exhibitors TBA", "W4", "Level 1", "1500", "", "comfirm with gordo", ""],
  ],
  ctxNik,
);
const nikFind = (text: string) => nik.rows.find((r) => r.data.signText === text);

describe("buildMasterPreview — live-sheet signage requests", () => {
  it("folds the signage request and sheet notes into the sign notes", () => {
    expect(nikFind("VETCON")?.data.notes).toContain(
      "Signage request: Include time of party on sign",
    );
    expect(nikFind("VETCON")?.data.notes).toContain("Notes: party at 9pm");
  });

  it("tags a 'confirm with X' request as needs-confirmation", () => {
    expect(nikFind("Training 01")?.tagSlugs).toContain("needs-confirmation");
    expect(nikFind("Training 01")?.tagSlugs).toContain("training");
  });

  it("catches the 'comfirm' typo even when the dept has no tag", () => {
    expect(nikFind("Exhibitors TBA")?.tagSlugs).toContain("needs-confirmation");
  });

  it("falls back to 22x28 for a department with no rule", () => {
    expect(nikFind("Exhibitors TBA")?.data.size).toBe("22x28");
    expect(nikFind("Exhibitors TBA")?.data.category).toBe("easel_sign");
  });

  it("does not flag a content request (no 'confirm') as needs-confirmation", () => {
    expect(nikFind("VETCON")?.tagSlugs).not.toContain("needs-confirmation");
  });
});

// M18: the sheet Name is the stable identifier (sheetName); the printed text
// (signText) is a `text should be/say/read "X"` override when present, else the Name.
// Every master row also carries the `master-sheet` provenance tag. SYNTHETIC rows.
const HOVR = [
  "Is it in the hall?", "Department", "Name", "Hall", "Level 1,2,3",
  "Booth/Room #", "Additional Signage Request", "Notes",
];
const ctxOvr = makeCtx({
  zones: { "LVCC-H4": 4, "LVCC-L2": 6 },
  tagSlugs: ["registration", "village"],
});
const ovr = buildMasterPreview(
  [
    HOVR,
    // straight-quote override -> printed text becomes Registration; Name stays id
    ["Y", "Registration", "Friday Reg - South", "W4", "Level 1", "1001", `text should be "Registration"`, ""],
    // smart-quote override + the "read" verb
    ["Y", "Registration", "DISPATCH & LOST & FOUND", "W4", "Level 1", "1002", `text should read “LOST & FOUND”`, ""],
    // no request -> signText == Name
    ["Y", "Registration", "Plain Desk", "W4", "Level 1", "1003", "", ""],
    // an apostrophe inside the override value must NOT truncate the printed text
    ["Y", "Registration", "Hackers Lounge", "W4", "Level 1", "1006", `text should be "Hacker's Lounge"`, ""],
    // non-override request -> signText == Name, request folds into notes
    ["Y", "Village", "Invite Party Room", "W4", "Level 1", "1004", "invite only party", ""],
    // non-hall village WITH an override -> primary overridden, its sock keeps the Name
    ["N", "Village", "Override Village", "Meeting Room", "Level 2", "W277", `text should say "Come In"`, ""],
  ],
  ctxOvr,
);
const ovrFind = (text: string, size?: string) =>
  ovr.rows.find(
    (r) => r.data.signText === text && (size === undefined || r.data.size === size),
  );

describe("buildMasterPreview — M18 sheetName + signText override", () => {
  it("tags every master space with the master-sheet provenance tag", () => {
    for (const r of ovr.rows) {
      expect(r.tagSlugs).toContain("master-sheet");
    }
  });

  it("sets sheetName to the Name and signText to a straight-quote override", () => {
    const reg = ovr.rows.find((r) => r.data.sheetName === "Friday Reg - South");
    expect(reg?.data.signText).toBe("Registration");
    // The override is captured as the printed text, so it is NOT folded into notes.
    expect(reg?.data.notes ?? "").not.toContain("Signage request");
  });

  it("reads a smart-quote override with the 'read' verb", () => {
    const lf = ovr.rows.find(
      (r) => r.data.sheetName === "DISPATCH & LOST & FOUND",
    );
    expect(lf?.data.signText).toBe("LOST & FOUND");
  });

  it("does not truncate an override value at an inner apostrophe", () => {
    const hl = ovr.rows.find((r) => r.data.sheetName === "Hackers Lounge");
    expect(hl?.data.signText).toBe("Hacker's Lounge");
  });

  it("leaves signText == sheetName when there is no request", () => {
    const plain = ovrFind("Plain Desk");
    expect(plain?.data.sheetName).toBe("Plain Desk");
    expect(plain?.data.signText).toBe("Plain Desk");
  });

  it("folds a non-override request into notes and keeps signText == Name", () => {
    const inv = ovrFind("Invite Party Room");
    expect(inv?.data.sheetName).toBe("Invite Party Room");
    expect(inv?.data.signText).toBe("Invite Party Room");
    expect(inv?.data.notes).toContain("Signage request: invite only party");
  });

  it("applies the override to the primary but not its sock (sock keeps the Name)", () => {
    const primary = ovrFind("Come In", "4'x8' Double");
    expect(primary?.data.sheetName).toBe("Override Village");
    const sock = ovrFind("Override Village", "Socks");
    expect(sock?.data.category).toBe("socks");
    expect(sock?.data.sheetName).toBe("Override Village");
    expect(sock?.data.signText).toBe("Override Village");
  });
});

// Master booth-collapse (EXHIBITOR ONLY): a con exhibitor spanning a contiguous
// booth block (Zyn at 1400/1401/1402) is fill-down'd to N identical rows in the
// master sheet, but should be ONE sign whose room is the range "1400-1402" (the
// manual Zyn fix). The rule fires ONLY for the raw exhibitor department, and ONLY
// for CONSECUTIVE same-Name rows. Villages/community/workshop/registration/training
// never collapse. SYNTHETIC rows — never written to a DB.
const HCOL = ["ID", "Department", "Name", "Hall", "Level 1,2,3", "Booth/Room #"];
const ctxCol = makeCtx({
  zones: { "LVCC-H1": 1, "LVCC-NH": 9, "LVCC-L2": 6 },
  tagSlugs: ["workshop", "registration", "training"],
});
const col = buildMasterPreview(
  [
    HCOL,
    // 3 consecutive exhibitor rows, same Name -> collapse to ONE sign (1400-1402)
    ["", "Exhibitor", "Zyn", "W1", "Level 1", "1400"],
    ["", "Exhibitor", "Zyn", "W1", "Level 1", "1401"],
    ["", "Exhibitor", "Zyn", "W1", "Level 1", "1402"],
    // workshop: same Name at two rooms -> NOT collapsed (2 signs)
    ["", "Workshops", "DC Workshop", "North Hall", "Level 2", "N253"],
    ["", "Workshops", "DC Workshop", "North Hall", "Level 2", "N254"],
    // registration: same Name at two rooms -> NOT collapsed (2 signs)
    ["", "Registration", "Reg Desk", "W1", "Level 1", "W104"],
    ["", "Registration", "Reg Desk", "W1", "Level 1", "W105"],
    // training: same Name at two rooms -> NOT collapsed (2 signs)
    ["", "Training", "Training 01", "Meeting Room", "Level 2", "W201"],
    ["", "Training", "Training 01", "Meeting Room", "Level 2", "W202"],
    // non-adjacent same-Name exhibitor: a DIFFERENT exhibitor sits between the two
    // Acme rows -> the Acme rows are non-contiguous and stay SEPARATE.
    ["", "Exhibitor", "Acme", "W1", "Level 1", "1500"],
    ["", "Exhibitor", "Beta", "W1", "Level 1", "1501"],
    ["", "Exhibitor", "Acme", "W1", "Level 1", "1502"],
    // distinct-Name adjacent exhibitor rows -> never merge
    ["", "Exhibitor", "Gamma", "W1", "Level 1", "1600"],
    ["", "Exhibitor", "Delta", "W1", "Level 1", "1601"],
  ],
  ctxCol,
);
const colFind = (name: string) =>
  col.rows.filter((r) => r.data.sheetName === name);

describe("isExhibitorDept", () => {
  it("matches the raw exhibitor department, case-insensitively", () => {
    expect(isExhibitorDept("Exhibitor")).toBe(true);
    expect(isExhibitorDept("Exhibitors")).toBe(true);
    expect(isExhibitorDept("EXHIBITOR")).toBe(true);
    expect(isExhibitorDept("Exhibition Hall")).toBe(true);
  });

  it("does not match non-exhibitor departments", () => {
    for (const d of ["Village", "Community", "Workshops", "Registration", "Training", "Contest"]) {
      expect(isExhibitorDept(d)).toBe(false);
    }
  });
});

describe("buildMasterPreview — exhibitor booth-collapse", () => {
  it("collapses 3 consecutive same-Name exhibitor rows into ONE sign", () => {
    const zyn = colFind("Zyn");
    expect(zyn).toHaveLength(1);
  });

  it("sets the collapsed sign's itemId + exactDestination to the room range", () => {
    const zyn = colFind("Zyn")[0];
    expect(zyn.data.itemId).toBe("1400-1402");
    expect(zyn.data.exactDestination).toBe("1400-1402");
    expect(zyn.data.placementArea).toBe("W1 1400-1402");
    // no exhibitor DEPT_RULES rule -> the 22x28 fallback size, one sign
    expect(zyn.data.size).toBe("22x28");
    expect(zyn.data.sheetName).toBe("Zyn");
  });

  it("does NOT collapse workshop rows (same Name, two rooms -> two signs)", () => {
    const ws = colFind("DC Workshop");
    expect(ws).toHaveLength(2);
    expect(ws.map((r) => r.data.itemId).sort()).toEqual(["N253", "N254"]);
  });

  it("does NOT collapse registration rows", () => {
    expect(colFind("Reg Desk")).toHaveLength(2);
  });

  it("does NOT collapse training rows", () => {
    expect(colFind("Training 01")).toHaveLength(2);
  });

  it("does NOT merge non-adjacent same-Name exhibitor rows", () => {
    const acme = colFind("Acme");
    expect(acme).toHaveLength(2);
    expect(acme.map((r) => r.data.itemId).sort()).toEqual(["1500", "1502"]);
  });

  it("does NOT merge distinct-Name adjacent exhibitor rows", () => {
    expect(colFind("Gamma")).toHaveLength(1);
    expect(colFind("Delta")).toHaveLength(1);
    expect(colFind("Gamma")[0].data.itemId).toBe("1600");
    expect(colFind("Delta")[0].data.itemId).toBe("1601");
  });

  it("reports the collapse as a preview notice", () => {
    expect(col.notices?.some((n) => /exhibitor booth-block/i.test(n))).toBe(true);
  });
});

describe("buildMasterPreview — exhibitor collapse edge cases", () => {
  const edge = buildMasterPreview(
    [
      HCOL,
      // two adjacent exhibitor rows, SAME name AND SAME room (accidental copy-paste)
      // -> one sign, itemId = the single room (not a degenerate "1700-1700" range)
      ["", "Exhibitor", "Dup", "W1", "Level 1", "1700"],
      ["", "Exhibitor", "Dup", "W1", "Level 1", "1700"],
    ],
    makeCtx({ zones: { "LVCC-H1": 1 } }),
  );

  it("collapses a same-room duplicate pair to one sign with the single room (no 1700-1700)", () => {
    const dup = edge.rows.filter((r) => r.data.sheetName === "Dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].data.itemId).toBe("1700");
    expect(dup[0].data.exactDestination).toBe("1700");
  });

  it("warns when a collapsed block's rows carry differing signage-request/notes", () => {
    // HCOL has no "Additional Signage Request" column, so the extra cell lands in an
    // unmapped column and the mapped signageRequest is "" for both rows -> no drift.
    // Re-run with a header that maps the request column to prove the warning fires.
    const HREQ = [...HCOL, "Additional Signage Request"];
    const drift = buildMasterPreview(
      [
        HREQ,
        ["", "Exhibitor", "Drift", "W1", "Level 1", "1800", "booth-1 note"],
        ["", "Exhibitor", "Drift", "W1", "Level 1", "1801", "booth-2 note"],
      ],
      makeCtx({ zones: { "LVCC-H1": 1 } }),
    );
    const row = drift.rows.find((r) => r.data.sheetName === "Drift");
    expect(row?.data.itemId).toBe("1800-1801"); // still collapsed
    expect(row?.warnings.some((w) => /differing signage-request/i.test(w))).toBe(true);
  });
});

// The collapsed range is built from the group's first and last room. Those used to be
// source-row order, so a hand-edited block listing its booths out of order printed a
// backwards range like "1402-1400" on the sign face (#235).
describe("buildMasterPreview — collapsed booth range is always low-to-high", () => {
  const rangeOf = (preview: ImportPreview, name: string) =>
    preview.rows.find((r) => r.data.sheetName === name)?.data.itemId;

  it("sorts an out-of-order numeric booth block", () => {
    const out = buildMasterPreview(
      [
        HCOL,
        ["", "Exhibitor", "Jumbled", "W1", "Level 1", "1402"],
        ["", "Exhibitor", "Jumbled", "W1", "Level 1", "1400"],
        ["", "Exhibitor", "Jumbled", "W1", "Level 1", "1401"],
      ],
      makeCtx({ zones: { "LVCC-H1": 1 } }),
    );
    expect(rangeOf(out, "Jumbled")).toBe("1400-1402");
  });

  it("leaves an already-ascending block exactly as before", () => {
    expect(colFind("Zyn")[0].data.itemId).toBe("1400-1402");
  });

  it("sorts hall-prefixed codes numerically, not lexically (W9 before W10)", () => {
    const out = buildMasterPreview(
      [
        HCOL,
        ["", "Exhibitor", "Prefixed", "W1", "Level 1", "W10"],
        ["", "Exhibitor", "Prefixed", "W1", "Level 1", "W9"],
      ],
      makeCtx({ zones: { "LVCC-H1": 1 } }),
    );
    expect(rangeOf(out, "Prefixed")).toBe("W9-W10");
  });

  it("orders sub-booth suffixes that share a number (1400A before 1400B)", () => {
    const out = buildMasterPreview(
      [
        HCOL,
        ["", "Exhibitor", "Suffixed", "W1", "Level 1", "1400B"],
        ["", "Exhibitor", "Suffixed", "W1", "Level 1", "1400A"],
      ],
      makeCtx({ zones: { "LVCC-H1": 1 } }),
    );
    expect(rangeOf(out, "Suffixed")).toBe("1400A-1400B");
  });

  it("falls back to a string compare for non-numeric room codes", () => {
    const out = buildMasterPreview(
      [
        HCOL,
        ["", "Exhibitor", "Named", "W1", "Level 1", "North Lobby"],
        ["", "Exhibitor", "Named", "W1", "Level 1", "East Lobby"],
      ],
      makeCtx({ zones: { "LVCC-H1": 1 } }),
    );
    expect(rangeOf(out, "Named")).toBe("East Lobby-North Lobby");
  });
});

// groupMasterRows is the shared grouping helper — the same collapse the reconcile
// path relies on (it parses the live sheet through buildMasterPreview). These probe
// the grouping directly so the adjacency rule is pinned independent of sign emission.
describe("groupMasterRows", () => {
  const rows = [
    ["", "Exhibitor", "Zyn", "1400"],
    ["", "Exhibitor", "Zyn", "1401"],
    ["", "Workshops", "WS", "N1"],
    ["", "Exhibitor", "Acme", "1500"],
    ["", "Exhibitor", "Beta", "1501"],
    ["", "Exhibitor", "Acme", "1502"],
  ];
  // name col = 2, dept col = 1
  const groups = groupMasterRows(rows, 2, 1, 2);

  it("groups consecutive same-Name exhibitor rows and leaves the rest single", () => {
    // Zyn(2 rows), WS(1), Acme(1), Beta(1), Acme(1) = 5 groups
    expect(groups).toHaveLength(5);
    expect(groups[0].rows).toHaveLength(2); // Zyn collapsed
    expect(groups[0].line).toBe(2); // 1-based line of the first Zyn row
    expect(groups.slice(1).every((g) => g.rows.length === 1)).toBe(true);
  });

  it("drops nameless rows and breaks adjacency across them", () => {
    const g = groupMasterRows(
      [
        ["", "Exhibitor", "Zyn", "1400"],
        ["", "TOTALS", "", ""], // nameless -> dropped + breaks the run
        ["", "Exhibitor", "Zyn", "1401"],
      ],
      2,
      1,
      2,
    );
    expect(g).toHaveLength(2); // the two Zyn rows do NOT merge across the gap
    expect(g.every((x) => x.rows.length === 1)).toBe(true);
  });
});

// Reconcile-path proof: the reconcile action (app/(app)/signs/reconcile/actions.ts)
// parses the live sheet through buildMasterPreview, then builds a SheetItem per
// preview row exactly as replicated below. This asserts that a re-sync of the SAME
// sheet matches the already-persisted collapsed sign (identity 1400-1402|zyn) rather
// than re-proposing the three individual booths as adds — the plan's main design risk.
function toSheetItem(row: MappedRow): SheetItem {
  const isSock = isSockCategory(row.data.category);
  const sheetName = row.data.sheetName ?? row.data.signText;
  return {
    identity: identityOf(row.data.itemId, sheetName, isSock),
    line: row.line,
    itemId: row.data.itemId,
    sheetName,
    signText: row.data.signText,
    isSock,
    deptTag: departmentTagFromSlugs(row.tagSlugs),
    snapshot: { signText: row.data.signText },
  };
}

describe("reconcile path — collapsed exhibitor does not re-propose booths", () => {
  const zynRow = colFind("Zyn")[0];
  const sheetItem = toSheetItem(zynRow);

  it("the collapsed sheet row carries the range identity", () => {
    expect(sheetItem.itemId).toBe("1400-1402");
    expect(sheetItem.identity).toBe(identityOf("1400-1402", "Zyn", false));
  });

  it("re-syncing the sheet against the persisted collapsed sign is a no-op (no adds)", () => {
    // The DB already holds the collapsed sign from a prior import/reconcile.
    const appSign = {
      id: 1,
      identity: identityOf("1400-1402", "Zyn", false),
      itemId: "1400-1402",
      sheetName: "Zyn",
      signText: "Zyn",
      isSock: false,
      deptTag: null,
      snapshot: { signText: "Zyn" },
    };
    const res = reconcile([sheetItem], [appSign]);
    expect(res.counts).toMatchObject({ add: 0, change: 0, remove: 0, unchanged: 1 });
  });

  it("without collapse the same sheet would have proposed 3 booth adds (regression guard)", () => {
    // Sanity: three individual booths against an empty DB would be three adds. The
    // collapse is what turns that into the single unchanged match above.
    const threeBooths: SheetItem[] = ["1400", "1401", "1402"].map((r) => ({
      identity: identityOf(r, "Zyn", false),
      line: 1,
      itemId: r,
      sheetName: "Zyn",
      signText: "Zyn",
      isSock: false,
      deptTag: null,
      snapshot: { signText: "Zyn" },
    }));
    expect(reconcile(threeBooths, []).counts.add).toBe(3);
  });
});
