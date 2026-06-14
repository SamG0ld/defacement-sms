import { formatDateTime } from "../../signs/_lib";

export type AuditRow = {
  id: number;
  action: string;
  actorEmail: string | null;
  detail: string | null;
  createdAt: Date;
};

// Admin/structural events: user-mgmt, imports, bulk ops, clears, equipment.
// (Per-sign status changes live on the Status tab / sign detail, not here.)
export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="panel px-3 py-6 text-center font-mono text-sm text-[var(--zinc-500)]">
        {"// no activity recorded yet"}
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
              <th>Who</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="t-mono whitespace-nowrap">
                  {formatDateTime(r.createdAt)}
                </td>
                <td className="t-dim">{r.actorEmail ?? "—"}</td>
                <td>
                  <span className="t-id">{r.action}</span>
                </td>
                <td className="t-dim">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
