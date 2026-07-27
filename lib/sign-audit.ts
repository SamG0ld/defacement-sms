// Sign-data health rules. Pure + dependency-light (only the room-code normalizer) so
// it unit-tests in isolation and runs the same way over a CSV export or a live-DB
// snapshot (scripts/signs-audit adapts either into AuditSign[]). Each rule surfaces a
// class of problem a human previously only caught by eyeballing an export: stale
// placeholders, the same space duplicated under variant room-code spellings, a name
// fill-dropped across booths, unconfirmed rows, and un-renderable rows.
//
// The normalizer (lib/room-code.ts) is the shared spine: the reconcile/import identity
// uses it to PREVENT variant-spelling dupes, and this audit uses it to DETECT the ones
// already in the data.
import { formatBucketForSize, formatForSize } from "./sign-format";
import { normalizeRoomCode } from "./room-code";

export type AuditSign = {
  id?: number; // DB id when available (--db mode); absent for CSV input
  itemId: string;
  signText: string;
  size: string;
  // signType / category power the format-mismatch rule. Optional: undefined means
  // "the source didn't provide this column" (skip that half of the check); a present
  // "" is a real blank value and IS checked. So an older export with no Type/Category
  // column never false-flags every on-format row.
  signType?: string;
  category?: string;
  tags: string[]; // tag slugs
  zone: string; // zoneCode, or ""
};

export type Severity = "high" | "medium" | "info";

// One issue instance. `signs` are the rows the finding is about — for the removable
// rules (stale placeholder, variant-code dupe) these are exactly the rows to clean up.
export type AuditFinding = {
  rule: string;
  severity: Severity;
  message: string;
  signs: AuditSign[];
};

export type AuditReport = {
  findings: AuditFinding[];
  counts: Record<string, number>; // rule -> finding count
};

const MASTER_SHEET_TAG = "master-sheet";
const ALL_VENUE_TAG = "all-venue";
const NEEDS_CONFIRMATION_TAG = "needs-confirmation";
const MAX_SIGN_TEXT = 80; // legibility ceiling for a single rendered line

const PLACEHOLDER_RE =
  /\bTBA\b|\bTBD\b|to be (announced|determined)|\bempty\b|\bplaceholder\b/i;

export function isPlaceholderText(text: string): boolean {
  return PLACEHOLDER_RE.test(text);
}

const has = (s: AuditSign, tag: string): boolean => s.tags.includes(tag);
const isRealText = (s: AuditSign): boolean =>
  s.signText.trim() !== "" && !isPlaceholderText(s.signText);

// Group signs by a derived key, preserving first-seen order.
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// 1) Stale placeholder: a booth (normalized room) has a placeholder sign
// ("Exhibitors TBA") AND a real-named sign — the placeholder is leftover and should
// be removed. A booth with ONLY placeholder(s) is genuinely unassigned → left alone.
export function findStalePlaceholders(signs: AuditSign[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [, group] of groupBy(signs, (s) => normalizeRoomCode(s.itemId))) {
    const placeholders = group.filter((s) => isPlaceholderText(s.signText));
    const real = group.filter(isRealText);
    if (placeholders.length > 0 && real.length > 0) {
      out.push({
        rule: "stale-placeholder",
        severity: "high",
        message: `Booth ${placeholders[0].itemId}: placeholder ${placeholders
          .map((s) => `"${s.signText}"`)
          .join(", ")} — booth is assigned (${real
          .map((s) => `"${s.signText}"`)
          .join(", ")}). Remove the placeholder.`,
        signs: placeholders,
      });
    }
  }
  return out;
}

// 2) Variant-code duplicate: the same sign text at room codes that NORMALIZE EQUAL but
// were written differently ("W204, W205" vs "W204-W205") — one space, duplicate signs.
export function findVariantCodeDupes(signs: AuditSign[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  // Key includes SIZE: a booth's meterboard and its sock are legitimately distinct
  // physical signs (same text, different size) — grouping them together would tell a
  // human to "keep one, drop the rest" and over-delete a real sign. One finding per
  // size means the "keep one canonical code" instruction is always accurate. JSON tuple
  // is collision-proof (no delimiter that could appear in signText) and printable.
  const key = (s: AuditSign) =>
    JSON.stringify([s.signText, normalizeRoomCode(s.itemId), s.size]);
  for (const [, group] of groupBy(signs.filter(isRealText), key)) {
    const rawCodes = [...new Set(group.map((s) => s.itemId))];
    if (rawCodes.length > 1) {
      out.push({
        rule: "variant-code-dupe",
        severity: "high",
        message: `"${group[0].signText}" (${group[0].size}) duplicated across room-code spellings: ${rawCodes
          .map((c) => `"${c}"`)
          .join(" / ")}. Keep one canonical code, drop the rest.`,
        signs: group,
      });
    }
  }
  return out;
}

// 3) Fill-down duplicate: the same real name at 2+ DIFFERENT booths (distinct
// normalized rooms) — a copy/paste fill-down (an exhibitor stamped onto several
// booths). all-venue signs (Code of Conduct ×10 etc.) are intentional multi-copy →
// excluded. Generic room labels (Workshop/Training) can also repeat legitimately, so
// this is review-severity, not an automatic delete.
export function findFillDownDupes(signs: AuditSign[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const candidates = signs.filter(
    (s) => isRealText(s) && !has(s, ALL_VENUE_TAG),
  );
  for (const [text, group] of groupBy(candidates, (s) => s.signText)) {
    const rooms = [...new Set(group.map((s) => normalizeRoomCode(s.itemId)))];
    if (rooms.length > 1) {
      out.push({
        rule: "fill-down-dupe",
        severity: "medium",
        message: `"${text}" appears at ${rooms.length} different booths (${group
          .map((s) => s.itemId)
          .join(", ")}). Likely a fill-down error — confirm each is a real, distinct space.`,
        signs: group,
      });
    }
  }
  return out;
}

// 4) Unconfirmed: rows tagged needs-confirmation — the sign list for that space isn't
// finalized. Informational: one finding listing them so nothing unfinalized prints
// unnoticed.
export function findUnconfirmed(signs: AuditSign[]): AuditFinding[] {
  const unconfirmed = signs.filter((s) => has(s, NEEDS_CONFIRMATION_TAG));
  if (unconfirmed.length === 0) return [];
  return [
    {
      rule: "unconfirmed",
      severity: "info",
      message: `${unconfirmed.length} sign(s) tagged needs-confirmation (list not finalized).`,
      signs: unconfirmed,
    },
  ];
}

// 5) Un-renderable: blank sign text, missing/Unspecified size, or text too long to
// render legibly on one line.
export function findUnrenderable(signs: AuditSign[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const s of signs) {
    const reasons: string[] = [];
    if (s.signText.trim() === "") reasons.push("blank Sign Text");
    if (s.size.trim() === "" || /unspecified/i.test(s.size))
      reasons.push(`size "${s.size}"`);
    if (s.signText.length > MAX_SIGN_TEXT)
      reasons.push(`text ${s.signText.length} chars (> ${MAX_SIGN_TEXT})`);
    if (reasons.length > 0) {
      out.push({
        rule: "un-renderable",
        severity: "medium",
        message: `Booth ${s.itemId || "(no id)"}: ${reasons.join(", ")}.`,
        signs: [s],
      });
    }
  }
  return out;
}

// 6) Format mismatch: a sign whose stored signType and/or category disagree with what
// its SIZE's canonical format says they should be — the drift that let signs 1004/1101
// ("creator stage headsets") keep size "4'x8' Single" while their type/category were
// changed to a poster, so the generator still batched them as 4'x8' meterboards. Keyed
// off the canonical Format table (lib/sign-format.ts), NOT a raw size-regex, so a
// printed ops map (size "4'x8' printed" → format signType "4'x8' printed", category
// ops_map) is judged against ITS format and never false-flagged as a meterboard.
// Rows whose size isn't a canonical format (a true one-off, or the to-be-cleaned
// "24\"x36\"" twin of 24x36) are outside this rule — that's a size-cleanup concern.
export function findFormatMismatches(signs: AuditSign[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const s of signs) {
    const fmt = formatForSize(s.size);
    if (!fmt) continue;
    const problems: string[] = [];
    if (s.signType !== undefined && s.signType !== fmt.signType) {
      problems.push(`type "${s.signType}" should be "${fmt.signType}"`);
    }
    if (s.category !== undefined && s.category !== fmt.category) {
      problems.push(`category "${s.category}" should be "${fmt.category}"`);
    }
    if (problems.length > 0) {
      out.push({
        rule: "format-mismatch",
        severity: "high",
        message: `Booth ${s.itemId || "(no id)"}: size "${s.size}" is ${fmt.label}, but ${problems.join(" and ")}. Re-set the format.`,
        signs: [s],
      });
    }
  }
  return out;
}

// Run every rule and bundle the report.
export function auditSigns(signs: AuditSign[]): AuditReport {
  const findings = [
    ...findStalePlaceholders(signs),
    ...findVariantCodeDupes(signs),
    ...findFillDownDupes(signs),
    ...findFormatMismatches(signs),
    ...findUnrenderable(signs),
    ...findUnconfirmed(signs),
  ];
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return { findings, counts };
}

export { MASTER_SHEET_TAG, ALL_VENUE_TAG };

// ── Resize drift (MOVE) ──────────────────────────────────────────────────────
// A separate, BATCH-aware diagnostic — deliberately NOT part of auditSigns(), whose
// flat AuditSign[] has no batch linkage. A generation batch is created per size (#159),
// so at generation every sign in a batch shared one format bucket. If a sign is resized
// afterwards, its CURRENT bucket diverges from its batch-mates' — its rendered instance
// still lives in the old size's Figma file while the record now counts it under the new
// size. This surfaces that so the per-size view can explain it; the reconcile manifest
// already ACTS on it (the moved node shows as a delete in the old file and an append in
// the new), so this drives no writes on its own.

export type DriftBatchSign = { id: number; itemId: string; size: string };
export type DriftBatch = { batchId: number; signs: DriftBatchSign[] };

// from/to are bucket LABELS (human-readable, e.g. "Foamcore 22×28").
export type ResizeDrift = {
  signId: number;
  itemId: string;
  batchId: number;
  from: string;
  to: string;
};

export function findResizeDrift(batches: DriftBatch[]): ResizeDrift[] {
  const out: ResizeDrift[] = [];
  for (const batch of batches) {
    if (batch.signs.length === 0) continue;
    // Home bucket = the plurality of the batch's signs' current buckets. A single
    // resized sign can't outvote the batch it came from, so the majority still names
    // the batch's original size. Ties resolve to the first-seen bucket (deterministic).
    const counts = new Map<string, number>();
    const labelByKey = new Map<string, string>();
    for (const s of batch.signs) {
      const bucket = formatBucketForSize(s.size);
      counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
      if (!labelByKey.has(bucket.key)) labelByKey.set(bucket.key, bucket.label);
    }
    let homeKey = batch.signs[0] ? formatBucketForSize(batch.signs[0].size).key : "";
    let best = -1;
    for (const [key, count] of counts) {
      if (count > best) {
        best = count;
        homeKey = key;
      }
    }
    const homeLabel = labelByKey.get(homeKey) ?? homeKey;
    for (const s of batch.signs) {
      const bucket = formatBucketForSize(s.size);
      if (bucket.key !== homeKey) {
        out.push({
          signId: s.id,
          itemId: s.itemId,
          batchId: batch.batchId,
          from: homeLabel,
          to: bucket.label,
        });
      }
    }
  }
  return out;
}
