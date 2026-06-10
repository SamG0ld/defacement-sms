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
      <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-6 text-center text-sm text-zinc-500">
        No activity recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Who</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.id} className="text-zinc-200">
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                {formatDateTime(r.createdAt)}
              </td>
              <td className="px-3 py-2 text-zinc-300">{r.actorEmail ?? "—"}</td>
              <td className="px-3 py-2">
                <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300">
                  {r.action}
                </code>
              </td>
              <td className="px-3 py-2 text-zinc-300">{r.detail ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
