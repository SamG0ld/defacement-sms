import Link from "next/link";

import type { SignStatus } from "@/app/generated/prisma/client";

import { formatDateTime, statusBadgeClass, statusLabel } from "../../signs/_lib";

export type StatusRow = {
  id: number;
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

// Global feed of per-sign status changes across all signs (the per-sign
// timeline still lives on each sign's detail page).
export function StatusTable({ rows }: { rows: StatusRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="panel px-3 py-6 text-center font-mono text-sm text-[var(--zinc-500)]">
        {"// no status changes recorded yet"}
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
                  <span className="flex items-center gap-1.5">
                    <StatusChip status={r.oldStatus} />
                    <span style={{ color: "var(--zinc-600)" }}>→</span>
                    <StatusChip status={r.newStatus} />
                  </span>
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
