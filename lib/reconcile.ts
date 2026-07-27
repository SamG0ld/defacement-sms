// Pure diff engine for the master-sheet reconcile (M18). Deliberately free of any
// app/DB imports so it unit-tests in isolation. Callers (the reconcile server
// action) build SheetItem[] from the master parser's output and AppSign[] from the
// current master-sheet-tagged DB signs, then call reconcile(). The result is a
// reviewable changeset — adds / signText changes / removes / ambiguous, plus an
// informational department-change bucket — that a lead accepts per-row.
//
// Identity = normRoomCode(itemId)|norm(sheetName)|(sock|primary). sheetName is the sheet's
// stable Name; it is deliberately NOT signText. signText is the PRINTED text (a
// "text should be X" override can change it), so keying identity on it would make an
// override read as DELETE+ADD and orphan the sign's app state. isSock stays in the
// key because one space yields two rows (a primary sign + a sock) that share
// room+name. See plans/m18-sheet-reconcile.md.

import { normalizeRoomCode } from "./room-code";

// The ONLY field reconcile compares and (on accept) writes: the printed text.
// Everything else on a sign — size/type/category (our DEPT_RULES derivation off the
// team's decisions), the folded notes blob, placement/zone, and ALL app state
// (status/QM/deploy/photos/…) — is team-owned and never touched. Keeping this a
// one-element list is the safety mechanism: the apply path builds its UPDATE payload
// FROM this list, so it physically cannot reach a team-owned column.
//
// It being a SINGLE per-row field is also what lets the apply path write in bounded
// chunks rather than one batch-wide transaction (see CHANGE_CHUNK in
// signs/reconcile/actions.ts): with no cross-row or cross-field invariant, a partially
// applied batch is always a legitimate DB state. Adding a second field that must move
// together with signText means revisiting that.
export const RECONCILE_FIELDS = ["signText"] as const;

export type ReconcileField = (typeof RECONCILE_FIELDS)[number];

export const FIELD_LABELS: Record<ReconcileField, string> = {
  signText: "Sign text",
};

// How many sign ids an apply result spells out before summarizing the rest. Lives
// here (a plain module) rather than in the reconcile Server Action file, which may
// only export async functions — so the audit detail and the wizard can't drift.
export const MAX_LISTED_FAILED_IDS = 20;

// The comparable slice of a sign — the reconciled field only. Built identically
// from a parsed sheet row and from a DB sign, so a diff is apples-to-apples.
export type ReconcileSnapshot = {
  signText: string;
};

export type SheetItem = {
  identity: string;
  line: number; // 1-based source row, for display
  itemId: string; // display
  sheetName: string; // the stable Name / identifier (display + identity)
  signText: string; // the printed text (the reconciled field)
  isSock: boolean;
  deptTag: string | null; // department tag, for the informational dept-change bucket
  snapshot: ReconcileSnapshot;
};

export type AppSign = {
  id: number;
  identity: string;
  itemId: string;
  sheetName: string;
  signText: string;
  isSock: boolean;
  deptTag: string | null;
  snapshot: ReconcileSnapshot;
};

export type FieldValue = string | number | boolean | null;

export type FieldChange = {
  field: ReconcileField;
  from: FieldValue; // current app value
  to: FieldValue; // proposed sheet value
};

export type AddChange = { type: "add"; identity: string; sheet: SheetItem };
export type UpdateChange = {
  type: "change";
  identity: string;
  signId: number;
  sheet: SheetItem;
  app: AppSign;
  fields: FieldChange[];
};
export type RemoveChange = {
  type: "remove";
  identity: string;
  signId: number;
  app: AppSign;
};
// An identity that matches more than one master-sheet sign: never auto-applied,
// only surfaced so a human can untangle it.
export type Ambiguous = {
  identity: string;
  sheetName: string;
  signIds: number[];
};
// A matched sign whose department changed in the sheet. INFORMATIONAL ONLY — size
// is team-owned, so this is never applied; it's a cue for the lead to re-decide that
// sign's size. Orthogonal to a signText change (a pair can have both, or just this).
export type DeptChange = {
  identity: string;
  signId: number;
  itemId: string;
  sheetName: string;
  from: string | null; // app's current department tag
  to: string | null; // sheet's department tag
};

export type ReconcileResult = {
  adds: AddChange[];
  changes: UpdateChange[];
  removes: RemoveChange[];
  ambiguous: Ambiguous[];
  deptChanges: DeptChange[];
  unchanged: number;
  counts: {
    add: number;
    change: number;
    remove: number;
    ambiguous: number;
    deptChange: number;
    unchanged: number;
  };
};

// Collapse the sheet's dirty reality (trailing whitespace, interior double spaces,
// case) so it never surfaces as a phantom identity change.
export function normalizeKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isSockCategory(category: string): boolean {
  return category === "socks";
}

// Identity keys the room component through normalizeRoomCode (not normalizeKeyPart),
// so formatting-only spellings of the same booth ("W204, W205" vs "W204-W205")
// collapse to one identity and can't create duplicate signs. sheetName still uses
// normalizeKeyPart — normalization can therefore only merge rows that are ALSO the
// same space by name, which bounds the blast radius. See lib/room-code.ts.
export function identityOf(
  itemId: string,
  sheetName: string,
  isSock: boolean,
): string {
  return `${normalizeRoomCode(itemId)}|${normalizeKeyPart(sheetName)}|${
    isSock ? "sock" : "primary"
  }`;
}

// The per-field diff for a matched pair. from = current app value, to = sheet value.
// signText is a canonical printed string — trim only (case is meaningful here), so a
// leading/trailing-whitespace quirk isn't a spurious change but a real edit surfaces.
export function diffSnapshots(
  app: ReconcileSnapshot,
  sheet: ReconcileSnapshot,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of RECONCILE_FIELDS) {
    if (app[field].trim() !== sheet[field].trim()) {
      out.push({ field, from: app[field], to: sheet[field] });
    }
  }
  return out;
}

// Two-way diff: sheet (upstream) vs current master-sheet signs (app). Any signText
// difference is a CHANGE surfaced for human review — there is no silent apply, so we
// don't need a baseline to detect conflicts. Removes are flag-only. Department
// changes are informational-only. The caller scopes appSigns (master-sheet-tagged
// signs only) before passing them in.
export function reconcile(
  sheetItems: SheetItem[],
  appSigns: AppSign[],
): ReconcileResult {
  const appByIdentity = new Map<string, AppSign[]>();
  for (const s of appSigns) {
    const arr = appByIdentity.get(s.identity);
    if (arr) arr.push(s);
    else appByIdentity.set(s.identity, [s]);
  }

  const adds: AddChange[] = [];
  const changes: UpdateChange[] = [];
  const ambiguous: Ambiguous[] = [];
  const deptChanges: DeptChange[] = [];
  let unchanged = 0;

  const sheetIdentities = new Set<string>();
  const flaggedAmbiguous = new Set<string>();

  for (const item of sheetItems) {
    sheetIdentities.add(item.identity);
    const matches = appByIdentity.get(item.identity);

    if (!matches || matches.length === 0) {
      adds.push({ type: "add", identity: item.identity, sheet: item });
      continue;
    }
    if (matches.length > 1) {
      if (!flaggedAmbiguous.has(item.identity)) {
        flaggedAmbiguous.add(item.identity);
        ambiguous.push({
          identity: item.identity,
          sheetName: item.sheetName,
          signIds: matches.map((m) => m.id),
        });
      }
      continue;
    }

    const app = matches[0];

    // Informational: the sheet reclassified this space's department. We never apply
    // it (size is team-owned), but a lead may want to re-decide the sign's size.
    if (app.deptTag !== item.deptTag) {
      deptChanges.push({
        identity: item.identity,
        signId: app.id,
        itemId: app.itemId,
        sheetName: app.sheetName,
        from: app.deptTag,
        to: item.deptTag,
      });
    }

    const fields = diffSnapshots(app.snapshot, item.snapshot);
    if (fields.length === 0) {
      unchanged += 1;
    } else {
      changes.push({
        type: "change",
        identity: item.identity,
        signId: app.id,
        sheet: item,
        app,
        fields,
      });
    }
  }

  // Removes: master-sheet signs whose identity the sheet no longer contains.
  // Flag-only — reconcile never deletes.
  const removes: RemoveChange[] = [];
  for (const s of appSigns) {
    if (sheetIdentities.has(s.identity)) continue;
    removes.push({ type: "remove", identity: s.identity, signId: s.id, app: s });
  }

  return {
    adds,
    changes,
    removes,
    ambiguous,
    deptChanges,
    unchanged,
    counts: {
      add: adds.length,
      change: changes.length,
      remove: removes.length,
      ambiguous: ambiguous.length,
      deptChange: deptChanges.length,
      unchanged,
    },
  };
}
