// The canonical sign-format table — one row per real physical sign shape the team
// prints. This is the SINGLE SOURCE OF TRUTH that ties size + signType + category +
// doubleSided + the needs-easel default together, so the create/edit form, the bulk
// "Set format" action, the sign-data audit, and the print counts can never disagree
// about what a given format means.
//
// Why a table and not just the size-string derivations in lib/print-summary.ts
// (signTypeFromSize / categoryFromSize): those map an ARBITRARY size string to a
// bucket (so any legacy/hand-typed size still classifies), but they can't express
// the two things a format needs — a stable picker identity + the doubleSided/easel
// defaults — and they mis-derive the printed ops maps' signType (a "4'x8' printed"
// venue map buckets as a meterboard by dimension, but its type is the printed string
// and its class is ops_map). The audit keys off THIS table precisely so those ops
// maps aren't false-positived as meterboard mismatches. The table stays in agreement
// with the derivations on every canonical size (guarded by a unit test) — it only
// overrides the two ops-map signTypes the dimension-regex can't know about.

import type { SignCategory } from "@/app/generated/prisma/enums";

export type SignFormat = {
  // Stable key used as the picker <option value> and the bulk-action payload. Never
  // reuse or renumber — it's the wire identity, not a display string.
  key: string;
  label: string; // human label in the picker
  size: string; // canonical Size string written to the row
  signType: string; // canonical Sign Type
  category: SignCategory; // physical item class
  doubleSided: boolean; // part of the format — never a checkbox that can be missed
  needsEasel: boolean; // the DEFAULT easel marking when this format is picked
};

// Foamcore easel boards, meterboards (single vs double are DISTINCT formats — double
// is two print faces at ~2× cost/production, never a buried checkbox), socks, and the
// two printed ops maps. Reconciled against the real prod size vocabulary; `24x36` is
// the canonical poster/foamcore size (its quoted `24"x36"` twin is a data-cleanup
// case the format-mismatch audit surfaces, not a second format).
export const SIGN_FORMATS = [
  {
    key: "foamcore-22x28",
    label: "Foamcore 22×28",
    size: "22x28",
    signType: '22"x28"',
    category: "easel_sign",
    doubleSided: false,
    needsEasel: true,
  },
  {
    key: "foamcore-24x36",
    label: "Foamcore 24×36",
    size: "24x36",
    signType: '24"x36"',
    category: "easel_sign",
    doubleSided: false,
    needsEasel: true,
  },
  {
    key: "meterboard-single",
    label: "Meterboard 4'×8' Single",
    size: "4'x8' Single",
    signType: "Meterboard (4'x8')",
    category: "meterboard",
    doubleSided: false,
    needsEasel: false,
  },
  {
    key: "meterboard-double",
    label: "Meterboard 4'×8' Double",
    size: "4'x8' Double",
    signType: "Meterboard (4'x8')",
    category: "meterboard",
    doubleSided: true,
    needsEasel: false,
  },
  {
    key: "socks",
    label: "Socks",
    size: "Socks",
    signType: "Socks",
    category: "socks",
    doubleSided: false,
    needsEasel: false,
  },
  {
    key: "opsmap-4x8",
    label: "Ops map 4'×8' (printed)",
    size: "4'x8' printed",
    signType: "4'x8' printed",
    category: "ops_map",
    doubleSided: false,
    needsEasel: false,
  },
  {
    key: "opsmap-24x36",
    label: "Ops map 24×36 (printed)",
    size: '24"x36" printed',
    signType: '24"x36" printed',
    category: "ops_map",
    doubleSided: false,
    needsEasel: false,
  },
] as const satisfies readonly SignFormat[];

export type SignFormatKey = (typeof SIGN_FORMATS)[number]["key"];

const BY_KEY = new Map<string, SignFormat>(SIGN_FORMATS.map((f) => [f.key, f]));
// Keyed by the exact canonical size string — a format's size is unique in the table,
// so this is the reverse lookup used to pre-select the picker on edit and to detect
// on-format vs off-format (custom-size) rows for the audit.
const BY_SIZE = new Map<string, SignFormat>(SIGN_FORMATS.map((f) => [f.size, f]));

// The format for a picker key, or undefined for the "custom / advanced" sentinel
// (any value not in the table, including "").
export function formatForKey(key: string | null | undefined): SignFormat | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

// The canonical format a sign's size maps to (exact size-string match), or undefined
// when the size isn't one of the canonical formats (a truly custom size, or the
// off-format `24"x36"` twin). Used to pre-select the form's Format picker and to scope
// the format-mismatch audit to on-format rows.
export function formatForSize(size: string | null | undefined): SignFormat | undefined {
  return size ? BY_SIZE.get(size) : undefined;
}

// The identity tuple that defines a sign's format (mirrors the SIGN_FORMATS shape).
// doubleSided is a NOT-NULL boolean column, so it's non-nullable here — that keeps
// the strict-equality diff in formatTupleDiffers consistent with the label lookup
// (no `Boolean(...)` coercion drift between the two).
export type SignFormatTuple = {
  size: string | null | undefined;
  signType: string | null | undefined;
  category: string | null | undefined;
  doubleSided: boolean;
};

// True when two format tuples differ on ANY identity field. The single definition
// both write paths (bulkSetFormat, updateSign) use to decide whether a reformat
// happened — keying on size alone would miss a signType/category/double-sided
// change at a constant size (a real reformat this system normalizes).
export function formatTupleDiffers(a: SignFormatTuple, b: SignFormatTuple): boolean {
  return (
    a.size !== b.size ||
    a.signType !== b.signType ||
    a.category !== b.category ||
    a.doubleSided !== b.doubleSided
  );
}

// A human label for a sign's format from its FULL identity tuple — the label the
// change-history timeline shows for a reformat. Distinct-by-design (Josh's call):
// keying on size alone collides when a change keeps the same size string (single↔
// double at custom sizes, or normalizing a mis-typed row whose size already matches
// the target). So we match the whole tuple to a canonical format and use its label;
// otherwise we describe the RAW shape (size, plus a 2-sided marker) rather than
// borrowing a canonical label the row doesn't actually match — that borrowing is
// exactly what produced "Foamcore 24×36 → Foamcore 24×36". A snapshot, not a key,
// so the row stays readable even if SIGN_FORMATS labels change later.
export function formatLabelForSign(sign: SignFormatTuple): string {
  const exact = SIGN_FORMATS.find(
    (f) =>
      f.size === sign.size &&
      f.signType === sign.signType &&
      f.category === sign.category &&
      f.doubleSided === sign.doubleSided,
  );
  if (exact) return exact.label;
  const size = sign.size && sign.size.trim() !== "" ? sign.size : "—";
  return sign.doubleSided ? `${size} (2-sided)` : size;
}

// A "generate/export by size" bucket: a stable key + display label a sign is
// grouped into for batching and the sectioned audit export. Every canonical
// format is its own bucket (single ≠ double — distinct Figma files/text); any
// off-format/custom size collapses into ONE "Other / custom" bucket so a stray
// hand-typed size can't spawn a batch-per-variant.
export type FormatBucket = { key: string; label: string };

// The single fallback bucket key. Not a real SIGN_FORMATS key, so it never
// collides with a format bucket.
export const CUSTOM_BUCKET_KEY = "custom";
const CUSTOM_BUCKET: FormatBucket = {
  key: CUSTOM_BUCKET_KEY,
  label: "Other / custom",
};

export function formatBucketForSize(
  size: string | null | undefined,
): FormatBucket {
  const fmt = formatForSize(size);
  return fmt ? { key: fmt.key, label: fmt.label } : CUSTOM_BUCKET;
}

// Sort rank for a bucket key: canonical formats keep their SIGN_FORMATS order;
// the custom bucket always sorts last. Used to order batches + the sectioned
// export by size instead of the (now uniform, no-op) deploymentPriority.
const BUCKET_ORDER = new Map<string, number>(
  SIGN_FORMATS.map((f, i) => [f.key, i]),
);
export function formatBucketOrder(key: string): number {
  return BUCKET_ORDER.get(key) ?? Number.MAX_SAFE_INTEGER;
}
