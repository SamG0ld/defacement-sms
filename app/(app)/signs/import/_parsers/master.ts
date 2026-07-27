// Parser for the "Master - Events & Spaces Inventory" layout: a structured table
// of every space (Name / Department / Level / Booth-Room#) after some metadata +
// TOTALS rows. Generates one candidate sign per space for the user to curate.
import { departmentTag, deptSize, SOCK_DEPARTMENTS } from "@/lib/con-config";
import { MASTER_SHEET_TAG } from "@/lib/tags";
import { categoryFromSize, signTypeFromSize } from "@/lib/print-summary";
import { normalizeKeyPart } from "@/lib/reconcile";

import {
  cell,
  categorizeRows,
  resolveTagSlugs,
  slugify,
  tooManyRows,
  type ImportPreview,
  type MappingContext,
  type RowDraft,
  type SignData,
} from "../_map";
import { findHeaderRow, levelToZoneCode, northHallZoneCode } from "../_parse";

// Find the first header column whose label matches a predicate.
function findCol(
  header: string[],
  match: (label: string) => boolean,
): number | undefined {
  const idx = header.findIndex((h) => match(h.trim().toLowerCase()));
  return idx === -1 ? undefined : idx;
}

// Whether a value reads as "yes" (the master's "Is it in the hall?" column).
const HALL_TRUTHY = new Set(["y", "yes", "true", "x", "1"]);
function isYes(raw: string): boolean {
  return HALL_TRUTHY.has(raw.trim().toLowerCase());
}

// The live sheet's Additional Signage Request occasionally dictates the exact
// PRINTED text — e.g. `text should be "Registration"`. When it does, that text
// becomes the sign's signText (the Name stays the reconcile identifier). Matches
// be / say / read with straight OR smart quotes; validated 5/5 with 0 false
// positives on the real DC34 sheet (see plans/m18-sheet-reconcile.md). Returns the
// trimmed inner text, or null when the request isn't an explicit text override.
//
// Each quote style is its own PAIRED group (not one shared character class) so a
// MATCHED pair delimits the value — otherwise an apostrophe inside the text (e.g.
// `text should be "Hacker's Lounge"`) would be read as the closing quote and
// truncate the printed text to "Hacker". The captures are negated classes with a
// hard {1,200} bound (a printed sign text is short), so matching stays linear — no
// ReDoS — and a pathological cell can't produce a giant capture.
const OVERRIDE_RE =
  /text should (?:be|say|read)\s*(?:"([^"]{1,200})"|'([^']{1,200})'|“([^”]{1,200})”|‘([^’]{1,200})’)/i;
function signTextOverride(signageRequest: string): string | null {
  // A real override is short; skip absurdly long cells entirely rather than scan
  // them (belt-and-suspenders against a giant crafted request cell).
  if (signageRequest.length > 1000) return null;
  const m = signageRequest.match(OVERRIDE_RE);
  const inner = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4])?.trim();
  return inner ? inner : null;
}

// The ONLY department that collapses a contiguous booth block into one sign.
// Keyed off the RAW Department cell, NOT a DEPT_RULES tag: exhibitors carry no
// rule (departmentTag("Exhibitors") is null -> the 22x28 fallback), so there is no
// tag to key on. Villages/community are deliberately NOT collapsed here — each is
// already one meterboard, and their variant-spelling dupes are handled elsewhere
// (Josh scoped this rule to exhibitors only, 2026-07-09).
export function isExhibitorDept(dept: string): boolean {
  return /exhibit/i.test(dept);
}

// Order two booth/room codes low-to-high. Codes are numeric ("1400") or carry a
// hall/level letter ("W204"), so compare the leading non-digit prefix first and the
// digit run numerically — a plain string sort would put "W10" before "W9". Codes
// that don't split that way (a named space like "North Lobby") fall back to a string
// compare. Used only to orient a collapsed booth RANGE; it never reorders rows.
function compareRoomCodes(a: string, b: string): number {
  const ma = /^(\D*)(\d+)/.exec(a);
  const mb = /^(\D*)(\d+)/.exec(b);
  if (ma && mb && ma[1].toUpperCase() === mb[1].toUpperCase()) {
    const byNumber = Number(ma[2]) - Number(mb[2]);
    // Fall through on a tie rather than returning 0: same digits with different
    // trailing text ("1400A" vs "1400B") still needs a defined order, and leaving
    // it to the sort's stability would put a reversed pair back in source order.
    if (byNumber !== 0) return byNumber;
  }
  return a.localeCompare(b);
}

// A group of source rows that becomes ONE sign. Almost every group is a single row
// (the unchanged one-sign-per-space behavior). The exception: a run of CONSECUTIVE
// rows with the SAME Name that both read as the exhibitor department collapses into
// one group — an entity spanning a contiguous booth block (Zyn at 1400/1401/1402)
// becomes one sign. The master sheet is sorted, so an entity's booths are adjacent
// rows; adjacency IS the grouping signal, so two same-Name exhibitor rows with a
// different entity (or a blank/TOTALS row) between them stay separate. Nameless rows
// (metadata / TOTALS / blanks) emit no sign and break an open run's adjacency.
//
// Shared by BOTH the import preview and the reconcile path: the reconcile action
// parses the live sheet through buildMasterPreview (which calls this), so a re-sync
// of the same sheet matches the collapsed sign instead of re-proposing each booth.
export type MasterRowGroup = { rows: string[][]; line: number };

export function groupMasterRows(
  dataRows: string[][],
  nameCol: number | undefined,
  deptCol: number | undefined,
  firstLine: number, // 1-based source line of dataRows[0]
): MasterRowGroup[] {
  const groups: MasterRowGroup[] = [];
  // The open exhibitor run we might still extend: its group, the row index of its
  // last member (adjacency check), and its normalized Name (the grouping key).
  let run: { group: MasterRowGroup; index: number; name: string } | null = null;

  dataRows.forEach((row, i) => {
    const name = cell(row, nameCol);
    if (!name) {
      run = null; // a gap makes any following same-Name exhibitor row non-contiguous
      return;
    }

    const line = firstLine + i;
    if (isExhibitorDept(cell(row, deptCol))) {
      const key = normalizeKeyPart(name);
      if (run && run.index === i - 1 && run.name === key) {
        run.group.rows.push(row);
        run.index = i;
        return;
      }
      const group: MasterRowGroup = { rows: [row], line };
      groups.push(group);
      run = { group, index: i, name: key };
      return;
    }

    // Any non-exhibitor space is its own sign and breaks an open exhibitor run.
    groups.push({ rows: [row], line });
    run = null;
  });

  return groups;
}

export function buildMasterPreview(
  rows: string[][],
  ctx: MappingContext,
): ImportPreview {
  if (rows.length === 0) {
    return {
      headerError: "The file is empty.",
      mappedColumns: [],
      ignoredHeaders: [],
      rows: [],
      counts: { valid: 0, invalid: 0, duplicate: 0, readd: 0, total: 0 },
    };
  }

  const headerIdx = findHeaderRow(rows, ["name", "department"]);
  if (headerIdx === -1) {
    return {
      headerError:
        'Could not find the master header row (needs "Name" and "Department").',
      mappedColumns: [],
      ignoredHeaders: [],
      rows: [],
      counts: { valid: 0, invalid: 0, duplicate: 0, readd: 0, total: 0 },
    };
  }

  const header = rows[headerIdx];
  const col = {
    name: findCol(header, (h) => h === "name"),
    department: findCol(header, (h) => h === "department"),
    hall: findCol(header, (h) => h === "hall"),
    level: findCol(header, (h) => h.includes("level")),
    room: findCol(header, (h) => h.includes("booth") || h.includes("room")),
    id: findCol(header, (h) => h === "id"),
    // DC34 added these; all optional so an older master still imports.
    inHall: findCol(header, (h) => h.includes("in the hall")),
    goonLead: findCol(header, (h) => h.includes("goon lead")),
    creatorPrimary: findCol(
      header,
      (h) => h.includes("creator") && h.includes("primary"),
    ),
    creatorSecond: findCol(
      header,
      (h) => h.includes("creator") && (h.includes("second") || h.includes("2")),
    ),
    floorplan: findCol(header, (h) => h.includes("floorplan")),
    // The live (Nikita) sheet adds a per-space signage instruction + a notes column.
    signageRequest: findCol(header, (h) => h.includes("signage request")),
    sheetNotes: findCol(header, (h) => h === "notes" || h === "note"),
  };

  const dataRows = rows.slice(headerIdx + 1);
  const capped = tooManyRows(dataRows.length);
  if (capped) return capped;

  // Group first: consecutive same-Name exhibitor rows collapse into one group (one
  // sign spanning the booth block); every other space is its own single-row group.
  const groups = groupMasterRows(dataRows, col.name, col.department, headerIdx + 2);

  const drafts: RowDraft[] = [];
  let sockCount = 0;
  let collapsedCount = 0;

  groups.forEach((group) => {
    const row = group.rows[0]; // representative row (all fields but the room match)
    const line = group.line;
    const name = cell(row, col.name); // guaranteed present by groupMasterRows

    const warnings: string[] = [];
    const dept = cell(row, col.department);
    const hall = cell(row, col.hall);
    const idVal = cell(row, col.id);

    // Consecutive same-Name exhibitor booths collapse into ONE sign spanning the
    // block (Zyn at 1400/1401/1402 -> one sign, room "1400-1402"). Only exhibitor
    // groups ever hold >1 row; every other space is a single-row group, so `room` is
    // just its own room and behavior is unchanged. On collapse the printed room +
    // itemId + exactDestination all become the range, matching the manual Zyn fix.
    const collapsed = group.rows.length > 1;
    if (collapsed) {
      collapsedCount += 1;
      // Only row 0's non-room fields feed the collapsed sign. If a later booth in the
      // block carries a DIFFERENT signage request or notes cell (a per-booth edit on an
      // otherwise fill-downed block), that detail would be dropped silently — warn so a
      // lead sees it on the row instead of losing it. Real fill-down data is identical
      // bar the room, so this stays quiet on the normal case.
      const baseReq = cell(row, col.signageRequest);
      const baseNotes = cell(row, col.sheetNotes);
      const drifted = group.rows
        .slice(1)
        .some(
          (r) =>
            cell(r, col.signageRequest) !== baseReq ||
            cell(r, col.sheetNotes) !== baseNotes,
        );
      if (drifted) {
        warnings.push(
          "collapsed exhibitor booths carried differing signage-request/notes cells; kept the first booth's",
        );
      }
    }
    // Sorted, not source order: the master is normally sorted, but a hand-edited
    // block can list its booths out of order (1402, 1400, 1401) and taking the first
    // and last rows verbatim printed a backwards range like "1402-1400" on the sign.
    const groupRooms = group.rows
      .map((r) => cell(r, col.room))
      .filter(Boolean)
      .sort(compareRoomCodes);
    const firstRoom = groupRooms[0] ?? "";
    const lastRoom = groupRooms[groupRooms.length - 1] ?? "";
    const room =
      collapsed && firstRoom && lastRoom && firstRoom !== lastRoom
        ? `${firstRoom}-${lastRoom}`
        : cell(row, col.room);

    // The master's Hall column uses "W1".."W4" for the exhibition halls; map
    // those to hall zones (whole-cell match so room codes don't false-positive).
    // "North Hall" rows (Diamond ballrooms / N2xx rooms) go to the North zone;
    // checked before the Level fallback so they are not mis-filed as West Level 2.
    const hallMatch = hall.trim().match(/^w\s*([1-4])$/i);
    const zoneCode = hallMatch
      ? `LVCC-H${hallMatch[1]}`
      : (northHallZoneCode(`${hall} ${room}`) ??
        levelToZoneCode(cell(row, col.level)));
    const zoneId = zoneCode
      ? (ctx.zoneByCode.get(zoneCode.toUpperCase()) ?? null)
      : null;

    const signageRequest = cell(row, col.signageRequest);
    const sheetNotes = cell(row, col.sheetNotes);

    // Department tag, plus a needs-confirmation tag when the signage request is a
    // "confirm with <person>" TODO — the live sheet's marker that the sign list for
    // that space isn't finalized. The /co[mn]firm/ pattern also catches the
    // "comfirm" typo in the source. Lets a lead filter unconfirmed signs in the UI
    // and clear the tag as they get confirmed.
    const tag = departmentTag(dept);
    // Trailing \b so "confirmed"/"confirmation" (already-done / noun) don't trip it;
    // still matches the imperative "confirm" and the "comfirm" typo.
    const needsConfirm = /\bco[mn]firm\b/i.test(signageRequest);
    // Every master-sheet space carries the `master-sheet` provenance tag (first, so
    // it's always present) — the marker the M18 reconcile scopes to. It's a system
    // tag, hidden from the user tag editor (lib/tags.ts).
    const tagSlugs = resolveTagSlugs(
      [MASTER_SHEET_TAG, tag, needsConfirm ? "needs-confirmation" : null].filter(
        (t): t is string => t !== null,
      ),
      ctx,
      warnings,
    );

    // Printed text: an explicit "text should be X" override when the request gives
    // one, else the space Name. The Name is always kept as sheetName (the stable
    // reconcile identifier), so the override only moves the printed text.
    const override = signTextOverride(signageRequest);
    const signText = override ?? name;

    const placement = [hall, room].filter(Boolean).join(" ") || null;

    // Fold the per-space detail into Notes so it's not lost: the signage request
    // and the sheet's own notes first (what the sign needs to say / open TODOs),
    // then the people/reference columns. Only present parts are included.
    const creators = [
      cell(row, col.creatorPrimary),
      cell(row, col.creatorSecond),
    ]
      .filter(Boolean)
      .join(" / ");
    const goonLead = cell(row, col.goonLead);
    const floorplan = cell(row, col.floorplan);
    const noteParts = [
      // An override request is captured as the printed text (signText), so it's not
      // also folded into notes; every other request still folds in exactly as before.
      !override && signageRequest ? `Signage request: ${signageRequest}` : "",
      sheetNotes ? `Notes: ${sheetNotes}` : "",
      dept ? `Department: ${dept}` : "",
      creators ? `Creators: ${creators}` : "",
      goonLead ? `Goon Lead: ${goonLead}` : "",
      floorplan ? `Floorplan: ${floorplan}` : "",
    ].filter(Boolean);
    const notes = noteParts.length > 0 ? noteParts.join(" · ") : null;

    // Size by department (deptSize / DEPT_RULES), falling back to the room-ID size. The
    // category / type / double-sided flag all derive from the size string, and
    // easel-class sizes (22x28 / 24x36) are the ones that need an easel stand.
    const size = deptSize(dept);
    const category = categoryFromSize(size);
    const itemId = room || idVal || `M-${slugify(name)}`.slice(0, 100);

    const primary: SignData = {
      itemId,
      signText,
      sheetName: name,
      signType: signTypeFromSize(size),
      size,
      quantity: 1,
      doubleSided: /double/i.test(size),
      needsEasel: category === "easel_sign",
      category,
      printable: true,
      placementArea: placement,
      // The room (Booth/Room#) is what the sign art prints bottom-right, verbatim
      // — so use the RAW room, not itemId. itemId has a fallback chain (idVal →
      // synthetic `M-<slug>`) for roomless spaces; printing that on the sign face
      // would be garbage. Null when the sheet has no room, so the generator renders
      // nothing there. The sock inherits this via the spread below. (A meaningful
      // non-numeric label like "North Lobby" lives in the room column, so it is
      // still captured.)
      exactDestination: room || null,
      notes,
      deploymentSlot: null,
      zoneId,
      eventStart: null,
      eventEnd: null,
    };
    drafts.push({ line, data: primary, tagSlugs, warnings });

    // Room-based (non-hall) village/community spaces also get a sock — a flying
    // sign with the room number to mark the entrance above the crowd. Only when
    // the master carries the "Is it in the hall?" column (older sheets don't, so
    // they keep the one-sign-per-space behavior). Distinct size keeps it from
    // deduping against the primary.
    // Absent column OR a blank cell → treat as in-hall (no sock); only an explicit
    // "no" earns a sock, so an unfilled row never fabricates one.
    const rawInHall = cell(row, col.inHall);
    const inHall =
      col.inHall === undefined || !rawInHall ? true : isYes(rawInHall);
    if (!inHall && tag !== null && SOCK_DEPARTMENTS.has(tag)) {
      drafts.push({
        line,
        data: {
          ...primary,
          // The sock is a separate physical sign (room-number entrance marker), so
          // a "text should be X" override on the primary never applies to it — its
          // printed text is the space Name (same sheetName keeps them a matched set).
          signText: name,
          signType: signTypeFromSize("Socks"),
          size: "Socks",
          doubleSided: false,
          needsEasel: false,
          category: categoryFromSize("Socks"),
          notes: [`Sock — room entrance marker${room ? ` (${room})` : ""}`, notes]
            .filter(Boolean)
            .join(" · "),
        },
        tagSlugs,
        warnings: [],
      });
      sockCount += 1;
    }
  });

  const notices: string[] = [];
  if (collapsedCount > 0) {
    notices.push(
      `Collapsed ${collapsedCount} exhibitor booth-block${collapsedCount === 1 ? "" : "s"} into a single sign each (one sign spanning the room range, e.g. 1400-1402).`,
    );
  }
  if (sockCount > 0) {
    notices.push(
      `Added ${sockCount} sock entrance-marker${sockCount === 1 ? "" : "s"} for room-based village/community spaces (one per space, on top of its main sign).`,
    );
  }

  return categorizeRows(drafts, ctx, {
    mappedColumns: ["name", "department", "level", "hall", "room"],
    ignoredHeaders: [],
    notices,
  });
}
