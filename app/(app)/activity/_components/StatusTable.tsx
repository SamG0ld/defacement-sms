import Link from "next/link";

import { changeSummary } from "@/lib/change-history";
import type { SignStatus } from "@/app/generated/prisma/client";

import { formatDateTime, statusBadgeClass, statusLabel } from "../../signs/_lib";

export type StatusRow = {
  id: number;
  changeType: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  changedBy: string | null;
  changedAt: Date;
  sign: { id: number; itemId: string; signText: string | null } | null;
};

// A status string from history may predate the current enum; statusBadgeClass
// falls back gracefully, and statusLabel echoes anything unknown verbatim.
function StatusChip({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: "var(--zinc-600)" }}>—</span>;
  const s = status as SignStatus;
  return <span className={`badge ${statusBadgeClass(s)}`}>{statusLabel(s)}</span>;
}

// A neutral tag marking a format (not status) change. Deliberately NOT the status
// badge — old/new here are format labels, never SignStatus values.
function FormatTag() {
  return (
    <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
      Format
    </span>
  );
}

// The "Change" cell: branch on change_type so a format row's labels never render
// through the status-badge renderer (which would echo them as bogus statuses).
function ChangeCell({ row }: { row: StatusRow }) {
  const c = changeSummary(row);
  if (c.isFormat) {
    return (
      <span className="flex items-center gap-1.5">
        <FormatTag />
        <span className="text-zinc-300">{c.from ?? "—"}</span>
        <span style={{ color: "var(--zinc-600)" }}>→</span>
        <span className="text-zinc-300">{c.to ?? "—"}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <StatusChip status={c.from} />
      <span style={{ color: "var(--zinc-600)" }}>→</span>
      <StatusChip status={c.to} />
    </span>
  );
}

// Global feed of per-sign status changes across all signs (the per-sign
// timeline still lives on each sign's detail page).
export function StatusTable({ rows }: { rows: StatusRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="panel px-3 py-6 text-center font-mono text-sm text-[var(--zinc-500)]">
        {"// no changes recorded yet"}
      </p>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="datatable">
          <thead>
            <tr>
              <th>When</th>
              <th>Sign</th>
              <th>Change</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="t-mono whitespace-nowrap">
                  {formatDateTime(r.changedAt)}
                </td>
                <td>
                  {r.sign ? (
                    <Link
                      href={`/signs/${r.sign.id}`}
                      className="t-id hover:underline"
                    >
                      {r.sign.itemId}
                      {r.sign.signText ? (
                        <span className="ml-2 t-dim">{r.sign.signText}</span>
                      ) : null}
                    </Link>
                  ) : (
                    <span style={{ color: "var(--zinc-500)" }}>
                      (deleted sign)
                    </span>
                  )}
                </td>
                <td>
                  <ChangeCell row={r} />
                </td>
                <td className="t-dim">{r.changedBy ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
