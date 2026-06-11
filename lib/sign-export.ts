// The /signs CSV export column contract — the 17-column shape the sign
// generators read (lib/sign-list.ts `parseSignListCsv`). Shared by the main
// filtered export (`signs/export`) and the per-batch generation handoff
// (`signs/generate/[id]/export`) so the two can never drift.

import type { Prisma } from "@/app/generated/prisma/client";

import { toCsv } from "@/lib/csv";

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
  "Deploy Slot",
  "Priority",
  "Cost/Unit",
  "Total Cost",
  "Requestor",
  "Tags",
  "Notes",
] as const;

// The Prisma `select` both export paths use — only the exported columns (the
// Sign row has ~60 columns; selecting all wastes width at export scale).
export const signExportSelect = {
  itemId: true,
  signText: true,
  signType: true,
  size: true,
  quantity: true,
  doubleSided: true,
  needsEasel: true,
  status: true,
  placementArea: true,
  deploymentSlot: true,
  deploymentPriority: true,
  costPerUnit: true,
  totalCost: true,
  requestor: true,
  notes: true,
  zone: { select: { zoneCode: true } },
  tagAssignments: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.SignSelect;

// Structural shape signRowsToCsv needs — a Prisma payload from signExportSelect
// satisfies it (Decimal has toFixed; SignStatus is a string subtype).
type Money = { toFixed(n: number): string } | null;
export type SignExportRow = {
  itemId: string;
  signText: string;
  signType: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  status: string;
  placementArea: string | null;
  deploymentSlot: string | null;
  deploymentPriority: number;
  costPerUnit: Money;
  totalCost: Money;
  requestor: string | null;
  notes: string | null;
  zone: { zoneCode: string } | null;
  tagAssignments: { tag: { name: string } }[];
};

// Prisma Decimal has toFixed directly — no float round-trip.
const money = (v: Money): string => (v == null ? "" : v.toFixed(2));

// Serialize selected sign rows to the canonical export CSV (header + rows),
// formula-injection-safe via toCsv.
export function signRowsToCsv(signs: SignExportRow[]): string {
  const rows = signs.map((s) => [
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
    s.deploymentSlot ?? "",
    s.deploymentPriority,
    money(s.costPerUnit),
    money(s.totalCost),
    s.requestor ?? "",
    s.tagAssignments.map((a) => a.tag.name).join("; "),
    s.notes ?? "",
  ]);
  return toCsv([[...SIGN_EXPORT_HEADER], ...rows]);
}
