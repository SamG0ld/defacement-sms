import { z } from "zod";

// QM (quartermaster) stock check-out — pure validation, group-identity, and clamp
// logic, no DB / no I/O so it can be unit-tested directly. The server action
// (signs/stock-actions.ts) owns the transaction + idempotency + row locking; this
// module owns "is this request well-formed", "what group does a sign belong to",
// and "does this batch delta fit the group".

// A batch take/return acts on at most a few hundred signs (e.g. Hotline ×20); 9999
// is a sane upper bound that still rejects a fat-fingered / forged huge count.
export const MAX_STOCK_N = 9999;

export const stockInputSchema = z.object({
  // A representative member of the group to act on. The action derives the whole
  // group (identical signs) from this row's identity, then takes/returns N pool
  // members — physical copies are interchangeable, so the caller needn't pick ids.
  signId: z.number().int().positive(),
  // How many to take or return in this one action (always positive; direction is
  // chosen by takeFromQm vs returnToQm, not by the sign of n).
  n: z.number().int().positive().max(MAX_STOCK_N),
  // Client-generated idempotency key (one per submit intent) so an at-least-once
  // replay — double-tap, offline queue drain, network retry — applies exactly once.
  clientId: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

export type StockInput = z.infer<typeof stockInputSchema>;

export type StockResult =
  | { ok: true; taken: number; remaining: number }
  | { ok: false; error: string };

// The fields that make two physical signs "the same" for QM grouping. Placement
// (zoneId, deploymentSlot) is included, so a copy assigned to a specific zone/slot
// splits out of the pile group; `status` is deliberately excluded so taken and
// untaken siblings stay in one group. Matches the Prisma `Sign` field names.
export type SignIdentity = {
  signText: string;
  signType: string;
  size: string;
  category: string;
  doubleSided: boolean;
  needsEasel: boolean;
  printable: boolean;
  zoneId: number | null;
  deploymentSlot: string | null;
};

// Prisma `select` for exactly the identity fields — shared by the action and the
// grouped list/rollup queries so the grouping key is defined in one place.
export const signIdentitySelect = {
  signText: true,
  signType: true,
  size: true,
  category: true,
  doubleSided: true,
  needsEasel: true,
  printable: true,
  zoneId: true,
  deploymentSlot: true,
} as const;

// Deterministic string key for a group — the serialized identity tuple. Used to
// label the ledger row and to key collapsed groups in the UI. JSON.stringify of an
// ordered array avoids separator collisions in the free-text fields (signText,
// deploymentSlot). The field order here is the canonical group-key order.
export function serializeGroupKey(id: SignIdentity): string {
  return JSON.stringify([
    id.signText,
    id.signType,
    id.size,
    id.category,
    id.doubleSided,
    id.needsEasel,
    id.printable,
    id.zoneId,
    id.deploymentSlot,
  ]);
}

// Given a group's committed counts (total rows, taken rows) and a signed delta
// (+n = take from QM, −n = return), compute the next taken count or the user-facing
// reason it's rejected. Never takes more than remain or returns more than are out.
// This is the optimistic client guard (signs/[id]/_StockControl) and the documented
// spec of the take/return bounds; the server action is the real authority and
// enforces the same bound atomically via UPDATE … WHERE id IN (SELECT … LIMIT n FOR
// UPDATE), rejecting a short flip.
export function nextGroupTaken(
  total: number,
  taken: number,
  delta: number,
): StockResult {
  const next = taken + delta;
  if (next < 0) {
    return { ok: false, error: "Can't return more than is checked out." };
  }
  if (next > total) {
    const remaining = total - taken;
    return {
      ok: false,
      error: `Only ${remaining} left at QM (you tried to take ${delta}).`,
    };
  }
  return { ok: true, taken: next, remaining: total - next };
}
