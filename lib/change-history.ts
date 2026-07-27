// Shared read model for a status_history row, used by BOTH change-history
// renderers — the global Activity feed (activity/_components/StatusTable) and the
// per-sign timeline (signs/[id]/page). The two MUST branch identically on
// change_type: a "format" row carries format LABEL strings in old/new_status, so it
// has to render as a neutral FORMAT change and NEVER go through the status-badge
// renderer (which echoes unknown strings verbatim — a mis-branch would silently show
// a format label as a bogus status badge, with no crash and no failing write test).
// Centralizing the discriminator here means the two renderers can't disagree on what
// counts as a format row, and it's unit-tested in one place.

// The change_type discriminator values. status_history is a TEXT column (it
// tolerates legacy/pre-enum values), so these aren't a Prisma enum; centralizing
// the literals here keeps the two writers and the renderers from drifting on a
// typo. Mirrors the schema's @default("status").
export const CHANGE_TYPE = { status: "status", format: "format" } as const;
export type ChangeType = (typeof CHANGE_TYPE)[keyof typeof CHANGE_TYPE];

export type ChangeHistoryRow = {
  changeType?: string | null;
  oldStatus: string | null;
  newStatus: string | null;
};

export type ChangeSummary = {
  // True when this row records a format change (labels in old/new), not a status
  // change (SignStatus values in old/new).
  isFormat: boolean;
  from: string | null;
  to: string | null;
};

export function changeSummary(row: ChangeHistoryRow): ChangeSummary {
  return {
    isFormat: row.changeType === CHANGE_TYPE.format,
    from: row.oldStatus,
    to: row.newStatus,
  };
}
