// Parser for the "Master - Events & Spaces Inventory" layout: a structured table
// of every space (Name / Department / Level / Booth-Room#) after some metadata +
// TOTALS rows. Generates one candidate sign per space for the user to curate.
import { ROOM_ID_SIGN_SIZE } from "@/lib/con-config";
import { categoryFromSize, signTypeFromSize } from "@/lib/print-summary";

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

// Department -> tag slug (the rest, e.g. GOON SPACE / OTHER, get no tag).
function departmentTag(dept: string): string | null {
  const t = dept.toLowerCase();
  if (/contest/.test(t)) return "contest";
  if (/village/.test(t)) return "village";
  if (/communit/.test(t)) return "community";
  if (/vendor/.test(t)) return "vendor";
  if (/registration|\breg\b/.test(t)) return "registration";
  return null;
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
      counts: { valid: 0, invalid: 0, duplicate: 0, total: 0 },
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
      counts: { valid: 0, invalid: 0, duplicate: 0, total: 0 },
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
  };

  const dataRows = rows.slice(headerIdx + 1);
  const capped = tooManyRows(dataRows.length);
  if (capped) return capped;

  const drafts: RowDraft[] = [];

  dataRows.forEach((row, i) => {
    const line = headerIdx + 2 + i;
    const name = cell(row, col.name);
    if (!name) return; // metadata / blank / totals rows have no Name

    const warnings: string[] = [];
    const dept = cell(row, col.department);
    const hall = cell(row, col.hall);
    const room = cell(row, col.room);
    const idVal = cell(row, col.id);

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

    const tag = departmentTag(dept);
    const tagSlugs = tag ? resolveTagSlugs([tag], ctx, warnings) : [];

    const placement = [hall, room].filter(Boolean).join(" ") || null;

    const data: SignData = {
      itemId: room || idVal || `M-${slugify(name)}`.slice(0, 100),
      signText: name,
      signType: signTypeFromSize(ROOM_ID_SIGN_SIZE), // room-ID signs are a standard 22"x28"
      size: ROOM_ID_SIGN_SIZE,
      quantity: 1,
      doubleSided: false,
      needsEasel: false,
      category: categoryFromSize(ROOM_ID_SIGN_SIZE), // standard room-ID poster -> easel_sign
      printable: true,
      placementArea: placement,
      notes: dept ? `Department: ${dept}` : null,
      deploymentSlot: null,
      zoneId,
      eventStart: null,
      eventEnd: null,
    };

    drafts.push({ line, data, tagSlugs, warnings });
  });

  return categorizeRows(drafts, ctx, {
    mappedColumns: ["name", "department", "level", "hall", "room"],
    ignoredHeaders: [],
  });
}
