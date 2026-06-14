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
      <p className="panel px-3 py-6 text-center font-mono text-sm text-[var(--zinc-500)]">
        {"// no deploy events recorded yet"}
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
              <th>Result</th>
              <th>By</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="t-mono whitespace-nowrap">
                  {formatDateTime(r.deployedAt)}
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
                      (deleted sign #{r.signId})
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <span
                    className={
                      r.status === "applied"
                        ? "badge badge-deployed"
                        : "badge"
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
                <td className="t-dim">{r.deployedByEmail ?? "—"}</td>
                <td className="t-dim max-w-xs truncate">{r.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
