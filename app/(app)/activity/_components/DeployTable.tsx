import Link from "next/link";

import { formatDateTime } from "../../signs/_lib";

export type DeployRow = {
  id: number;
  clientId: string;
  signId: number;
  status: string; // "applied" | "conflict"
  deployedByEmail: string | null;
  deployedAt: Date;
  notes: string | null;
  hasPhoto: boolean;
  // Resolved from a separate sign lookup (DeployEvent is FK-free, so a sign may
  // have been deleted since the event was logged).
  sign: { id: number; itemId: string; signText: string | null } | null;
};

// Append-only field deployment log: every deploy event a crew synced, including
// the conflicts (a second crew that deployed an already-deployed sign). The
// "applied" row is the one that set the sign's terminal state; "conflict" rows
// are the after-action record, never a state change.
export function DeployTable({ rows }: { rows: DeployRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-6 text-center text-sm text-zinc-500">
        No deploy events recorded yet.
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
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">By</th>
            <th className="px-3 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.id} className="text-zinc-200">
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                {formatDateTime(r.deployedAt)}
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
                  <span className="text-zinc-500">(deleted sign #{r.signId})</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs">
                <span
                  className={
                    r.status === "applied"
                      ? "badge-deployed rounded border px-2 py-0.5"
                      : "rounded border border-zinc-700 px-2 py-0.5 text-zinc-400"
                  }
                >
                  {r.status}
                </span>
                {r.hasPhoto ? (
                  // THIS event's photo (keyed by clientId), not the sign's
                  // current photo — a later deploy of the same sign must not
                  // rewrite what this after-action row shows.
                  <Link
                    href={`/api/native/deploys/${r.clientId}/photo`}
                    className="ml-2 text-accent hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    photo
                  </Link>
                ) : null}
              </td>
              <td className="px-3 py-2 text-zinc-300">
                {r.deployedByEmail ?? "—"}
              </td>
              <td className="max-w-xs truncate px-3 py-2 text-xs text-zinc-400">
                {r.notes ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
