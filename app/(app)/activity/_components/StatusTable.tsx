import Link from "next/link";

import { formatDateTime } from "../../signs/_lib";

export type StatusRow = {
  id: number;
  oldStatus: string | null;
  newStatus: string | null;
  changedBy: string | null;
  changedAt: Date;
  sign: { id: number; itemId: string; signText: string | null } | null;
};

// Global feed of per-sign status changes across all signs (the per-sign
// timeline still lives on each sign's detail page).
export function StatusTable({ rows }: { rows: StatusRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-6 text-center text-sm text-zinc-500">
        No status changes recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Sign</th>
            <th className="px-3 py-2 font-medium">Change</th>
            <th className="px-3 py-2 font-medium">By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.id} className="text-zinc-200">
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                {formatDateTime(r.changedAt)}
              </td>
              <td className="px-3 py-2">
                {r.sign ? (
                  <Link
                    href={`/signs/${r.sign.id}`}
                    className="text-accent hover:underline"
                  >
                    {r.sign.itemId}
                    {r.sign.signText ? (
                      <span className="ml-2 text-xs text-zinc-500">
                        {r.sign.signText}
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  <span className="text-zinc-500">(deleted sign)</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs">
                <span className="text-zinc-500">{r.oldStatus ?? "—"}</span>
                <span className="mx-1 text-zinc-600">→</span>
                <span className="text-zinc-200">{r.newStatus ?? "—"}</span>
              </td>
              <td className="px-3 py-2 text-zinc-300">{r.changedBy ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
