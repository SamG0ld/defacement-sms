// Parser for the DC33 "Sign Sheet" layout: a print list grouped into
// material/category sections, with a wide per-sign "DEPLOY BY <slot>" X-matrix
// and rotating-event time windows in the Notes column. Closes the gaps the
// generic parser drops (deploy matrix, blank Map#, section rows).
import { CON_SLUG, CON_YEAR } from "@/lib/con-config";
import {
  categoryFromSize,
  sectionCategory,
  signTypeFromSize,
} from "@/lib/print-summary";
import type { SignCategory } from "@/app/generated/prisma/enums";

import {
  cell,
  categorizeRows,
  clampQuantity,
  isTruthy,
  mapHeaders,
  resolveTagSlugs,
  slugify,
  tooManyRows,
  type ImportPreview,
  type MappingContext,
  type RowDraft,
  type SignData,
} from "../_map";
import {
  deployHeaderDate,
  findHeaderRow,
  hallZoneCode,
  levelToZoneCode,
  northHallZoneCode,
  parseDeployMatrix,
  parseEventWindow,
} from "../_parse";

// Section-header label -> tag slug (the category a run of rows belongs to).
function categoryTag(label: string): string | null {
  const t = label.toLowerCase();
  if (/command map/.test(t)) return "command-map";
  if (/village|communit/.test(t)) return "village";
  if (/contest/.test(t)) return "contest";
  if (/part|meetup|event/.test(t)) return "party";
  if (/workshop/.test(t)) return "workshop";
  if (/wayfind/.test(t)) return "wayfinding";
  return null;
}

// A material/size section label (sets the default size for rows beneath it).
function isMaterialLabel(label: string): boolean {
  return (
    /\d+\s*"|meter\s*board|socks|flying|stretch fabric|graphic|banner/i.test(
      label,
    ) || /\d+'\s*x/i.test(label)
  );
}

// A material section may itself imply a tag (carried alongside the category).
function materialTag(label: string): string | null {
  const t = label.toLowerCase();
  if (/command map/.test(t)) return "command-map";
  if (/sock|flying/.test(t)) return "flying-sign";
  if (/meter\s*board/.test(t)) return "meterboard";
  if (/stretch fabric|venue map|u\s*shape/.test(t)) return "venue-map";
  if (/banner/.test(t)) return "banner";
  return null;
}

// A floor/hall section label -> zone code. North Hall and the West halls (1-4)
// are their own zones and take precedence over the level they sit on.
function floorZoneCode(label: string): string | null {
  return (
    northHallZoneCode(label) ?? hallZoneCode(label) ?? levelToZoneCode(label)
  );
}

export function buildSignSheetPreview(
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

  const headerIdx = findHeaderRow(rows, ["sign text", "map#"]);
  if (headerIdx === -1) {
    return {
      headerError:
        'Could not find the sign-sheet header row (needs "Map#" and "Sign Text").',
      mappedColumns: [],
      ignoredHeaders: [],
      rows: [],
      counts: { valid: 0, invalid: 0, duplicate: 0, total: 0 },
    };
  }

  const header = rows[headerIdx];
  const map = mapHeaders(header);
  const deployCols = parseDeployMatrix(header);
  const dataRows = rows.slice(headerIdx + 1);

  const capped = tooManyRows(dataRows.length);
  if (capped) return capped;

  // Running section state. A material section starts a fresh block (resets the
  // category + floor so tags don't leak across); category/floor sub-headers
  // refine it within the block.
  let currentCategoryTag: string | null = null;
  let currentMaterialTag: string | null = null;
  let currentMaterial: string | null = null;
  let currentZoneCode: string | null = null;
  let currentCategory: SignCategory | null = null;

  // Once the specialty graphics sub-table starts (shifted columns: floor/wall
  // graphics, venue maps, sticker walls), stop importing — those are entered via
  // the sign form, not this sheet. Track how many rows we skipped so we can say so.
  let inSpecialtySection = false;
  let specialtySkipped = 0;

  const drafts: RowDraft[] = [];

  dataRows.forEach((row, i) => {
    const line = headerIdx + 2 + i; // 1-based source line
    const signText = cell(row, map.signText);
    const labelCell = cell(row, map.itemId);

    // Specialty graphics sub-table (and everything after): skip, entered via form.
    if (inSpecialtySection) {
      if (row.some((c) => (c ?? "").trim() !== "")) specialtySkipped++;
      return;
    }
    if (/specialty section/i.test(signText) || /specialty section/i.test(labelCell)) {
      inSpecialtySection = true;
      return;
    }
    // Template rows whose Map# cell is exactly "example" (the sheet's banner
    // placeholder) aren't real signs.
    if (labelCell.toLowerCase() === "example") return;

    // Section / blank rows (no sign text): update state, then skip.
    if (!signText) {
      if (!labelCell) return; // blank separator
      const fz = floorZoneCode(labelCell);
      if (fz) {
        currentZoneCode = fz; // floor sub-header within the current block
      } else if (isMaterialLabel(labelCell)) {
        currentMaterial = labelCell;
        currentMaterialTag = materialTag(labelCell);
        currentCategory = sectionCategory(labelCell); // item class for this block
        currentCategoryTag = null; // new block: drop the previous category/floor
        currentZoneCode = null;
      } else {
        const tag = categoryTag(labelCell);
        if (tag) currentCategoryTag = tag;
      }
      return;
    }

    const warnings: string[] = [];
    const sizeRaw = cell(row, map.size) || currentMaterial || "";
    const placementArea = cell(row, map.placementArea) || null;

    // deploy slot + the deadline date from the first deploy column carrying an X.
    let deploymentSlot: string | null = null;
    let deployByDate: Date | null = null;
    for (const dc of deployCols) {
      if (isTruthy(cell(row, dc.index))) {
        deploymentSlot = dc.slot;
        deployByDate = deployHeaderDate(header[dc.index], CON_YEAR);
        break;
      }
    }

    const notes = cell(row, map.notes) || null;
    const { eventStart, eventEnd } = parseEventWindow(notes, CON_YEAR);
    if (notes && notes.includes(";")) {
      warnings.push("additional event time window(s) not captured");
    }

    // zone: explicit zone col -> location text -> current floor section.
    let zoneId: number | null = null;
    const explicitZone = cell(row, map.zone);
    const zoneCode =
      (explicitZone && explicitZone.toUpperCase()) ||
      northHallZoneCode(placementArea ?? "") ||
      hallZoneCode(placementArea ?? "") ||
      levelToZoneCode(placementArea ?? "") ||
      currentZoneCode;
    if (zoneCode) zoneId = ctx.zoneByCode.get(zoneCode.toUpperCase()) ?? null;

    // Carry BOTH the material tag (flying-sign/meterboard/...) and the category
    // tag (village/contest/...), filtering nulls.
    const tagSlugs = resolveTagSlugs(
      [currentMaterialTag, currentCategoryTag].filter(
        (t): t is string => t !== null,
      ),
      ctx,
      warnings,
    );

    // Stable synthetic id when Map# is blank: derived from content (not line
    // number) so re-importing an edited sheet still dedupes.
    const autoId = `${CON_SLUG}-${slugify(signText)}-${slugify(placementArea ?? "")}`.slice(
      0,
      100,
    );

    const data: SignData = {
      itemId: labelCell || autoId,
      signText,
      signType: cell(row, map.signType) || signTypeFromSize(sizeRaw),
      size: sizeRaw || "Unspecified",
      quantity: clampQuantity(cell(row, map.quantity)),
      doubleSided: /double/i.test(sizeRaw),
      needsEasel: isTruthy(cell(row, map.needsEasel)),
      // Section class wins (the sheet's own grouping is authoritative); size is the
      // fallback. Bare-easel rows ("(easels only)") need easels but print nothing.
      category: currentCategory ?? categoryFromSize(sizeRaw),
      printable: !/easels?\s*only/i.test(signText),
      placementArea,
      notes,
      deploymentSlot,
      zoneId,
      eventStart,
      eventEnd,
      deployByDate,
    };

    drafts.push({ line, data, tagSlugs, warnings });
  });

  const notices: string[] = [];
  if (specialtySkipped > 0) {
    notices.push(
      `Specialty section detected — ${specialtySkipped} row(s) below it were not imported (floor/wall graphics, venue maps, sticker walls). Add these via the sign form.`,
    );
  }

  return categorizeRows(drafts, ctx, {
    mappedColumns: [
      "itemId",
      "signText",
      "size",
      "quantity",
      "needsEasel",
      "category",
      "placementArea",
      "notes",
      `deploy-matrix(${deployCols.length})`,
      "section-tags",
      "event-times",
    ],
    ignoredHeaders: [],
    notices,
  });
}
