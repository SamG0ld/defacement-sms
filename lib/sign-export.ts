// The /signs CSV export column contract — the column shape the sign generators
// read (lib/sign-list.ts `parseSignListCsv`), defined once by
// SIGN_EXPORT_HEADER below. Shared by the main filtered export
// (`signs/export`) and the per-batch generation handoff
// (`signs/generate/[id]/export`) so the two can never drift.

import type { Prisma } from "@/app/generated/prisma/client";

import { toCsv } from "@/lib/csv";
import { formatBucketForSize, formatBucketOrder } from "@/lib/sign-format";

// Safety cap shared by both export paths (main filtered export + per-batch
// handoff) so an unfiltered/oversized pull can't materialize the whole table.
// Comfortably above the real board (~hundreds of signs).
export const MAX_EXPORT_ROWS = 10_000;

export const SIGN_EXPORT_HEADER = [
  "Item ID",
  "Sign Text",
  "Type",
  "Size",
  "Qty",
  "Double-Sided",
  "Needs Easel",
  "Status",
  "Zone",
  "Placement",
  "Room",
  "Deploy Slot",
  "Priority",
  "Cost/Unit",
  "Total Cost",
  "Requestor",
  "Tags",
  "Notes",
  // Item class, appended after the original 18 so existing column positions (and the
  // generator contract) are unchanged. Lets the sign-data audit check category ↔
  // format over an export. Not re-imported (the import "category" alias binds the Tags
  // column), so this is export/audit-only — no round-trip regression.
  "Category",
  // Back-face text for a double-sided board whose faces differ (blank otherwise).
  // Appended last (append-only) so column positions stay stable; round-trips back
  // onto Sign.backText on re-import.
  "Back Text",
] as const;

// The Prisma `select` both export paths use — only the exported columns (the
// Sign row has ~60 columns; selecting all wastes width at export scale).
export const signExportSelect = {
  itemId: true,
  signText: true,
  backText: true,
  signType: true,
  size: true,
  category: true,
  quantity: true,
  doubleSided: true,
  needsEasel: true,
  status: true,
  placementArea: true,
  exactDestination: true,
  deploymentSlot: true,
  deploymentPriority: true,
  costPerUnit: true,
  totalCost: true,
  requestor: true,
  notes: true,
  zone: { select: { zoneCode: true } },
  // Slug, not name: the import parser resolves the Tags column by slug
  // (slugify → ctx.tagSlugs). Exporting the display name "Meter Board" would
  // slugify to "meter-board" and miss a stored slug of "meterboard", silently
  // dropping the tag on re-import. Slugs round-trip exactly.
  tagAssignments: { select: { tag: { select: { slug: true } } } },
} satisfies Prisma.SignSelect;

// Structural shape signRowsToCsv needs — a Prisma payload from signExportSelect
// satisfies it (Decimal has toFixed; SignStatus is a string subtype).
type Money = { toFixed(n: number): string } | null;
export type SignExportRow = {
  itemId: string;
  signText: string;
  backText: string | null;
  signType: string;
  size: string;
  category: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  status: string;
  placementArea: string | null;
  exactDestination: string | null;
  deploymentSlot: string | null;
  deploymentPriority: number;
  costPerUnit: Money;
  totalCost: Money;
  requestor: string | null;
  notes: string | null;
  zone: { zoneCode: string } | null;
  tagAssignments: { tag: { slug: string } }[];
};

// Prisma Decimal has toFixed directly — no float round-trip.
const money = (v: Money): string => (v == null ? "" : v.toFixed(2));

// The ordered cells for one sign — the single source of the column shape, shared
// by the flat export and the sectioned audit export so they can never drift.
function signRowCells(s: SignExportRow): (string | number)[] {
  return [
    s.itemId,
    s.signText,
    s.signType,
    s.size,
    s.quantity,
    s.doubleSided ? "Yes" : "No",
    s.needsEasel ? "Yes" : "No",
    s.status,
    s.zone?.zoneCode ?? "",
    s.placementArea ?? "",
    s.exactDestination ?? "",
    s.deploymentSlot ?? "",
    s.deploymentPriority,
    money(s.costPerUnit),
    money(s.totalCost),
    s.requestor ?? "",
    s.tagAssignments.map((a) => a.tag.slug).join("; "),
    s.notes ?? "",
    s.category,
    s.backText ?? "",
  ];
}

// Serialize selected sign rows to the canonical export CSV (header + rows),
// formula-injection-safe via toCsv. This is the MACHINE contract the generators
// re-import (parseSignListCsv) — keep it flat, no section rows.
export function signRowsToCsv(signs: SignExportRow[]): string {
  return toCsv([[...SIGN_EXPORT_HEADER], ...signs.map(signRowCells)]);
}

// Human-audit variant: the SAME SIGN_EXPORT_HEADER columns, but grouped into `=== FORMAT ===`
// sections — one per size in format order, off-format sizes under a single
// "Other / custom" section, rows within a section ordered by Item ID. The
// section header rows make this deliberately NON-round-trippable: it's a
// read-only report for eyeballing a by-size breakdown and is NEVER fed back
// through parseSignListCsv (that stays on signRowsToCsv). formula-injection-safe
// via toCsv — the leading `=` on each section marker is neutralized to text, so
// it can't execute in a spreadsheet yet still renders as `=== … ===`.
export function signRowsToSectionedCsv(signs: SignExportRow[]): string {
  const buckets = new Map<string, { label: string; rows: SignExportRow[] }>();
  for (const s of signs) {
    const b = formatBucketForSize(s.size);
    const existing = buckets.get(b.key);
    if (existing) existing.rows.push(s);
    else buckets.set(b.key, { label: b.label, rows: [s] });
  }
  const ordered = [...buckets.entries()].sort(
    ([a], [b]) => formatBucketOrder(a) - formatBucketOrder(b),
  );

  const rows: (string | number)[][] = [[...SIGN_EXPORT_HEADER]];
  for (const [, bucket] of ordered) {
    const n = bucket.rows.length;
    rows.push([`=== ${bucket.label} (${n} sign${n === 1 ? "" : "s"}) ===`]);
    const sorted = [...bucket.rows].sort((a, b) =>
      a.itemId.localeCompare(b.itemId),
    );
    for (const s of sorted) rows.push(signRowCells(s));
  }
  return toCsv(rows);
}
