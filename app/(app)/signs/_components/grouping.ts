import { serializeGroupKey } from "@/lib/stock";

import type { SignRow } from "./types";

// A group of identical signs (sharing the identity key — physical fields +
// placement, status excluded). The list collapses size > 1 groups under one
// expandable header; size-1 groups render as normal rows. `taken` / `remaining`
// drive the "N at QM" header readout.
export type SignGroup = {
  key: string;
  rows: SignRow[];
  // A representative member's id — passed to the take/return action, which derives
  // the whole group from it.
  repId: number;
  total: number;
  taken: number;
  remaining: number;
};

// Collapse an already-ordered list of rows into groups, preserving order (the first
// member's position, which is its MIN(deploymentPriority, itemId) since the input is
// pre-sorted). In-memory because the signs list is bounded to a con's few hundred
// rows; grouping that set is trivial and keeps selection / status / hardware islands
// exactly as the row-based list rendered them.
export function groupSignRows(rows: SignRow[]): SignGroup[] {
  const groups = new Map<string, SignRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const key = serializeGroupKey(r);
    const existing = groups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      groups.set(key, [r]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const groupRows = groups.get(key)!;
    const taken = groupRows.filter((r) => r.qmTakenAt !== null).length;
    return {
      key,
      rows: groupRows,
      repId: groupRows[0].id,
      total: groupRows.length,
      taken,
      remaining: groupRows.length - taken,
    };
  });
}
