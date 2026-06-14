import { formatUserAgent } from "@/lib/request-context";

import { formatDateTime } from "../../signs/_lib";

export type LoginRow = {
  id: number;
  action: string;
  actorEmail: string | null;
  detail: string | null;
  location: string | null;
  userAgent: string | null;
  createdAt: Date;
};

// Authentication events: successful sign-ins (auth.login) and rejected attempts
// (auth.denied). Admin-only — it carries coarse location + device (PII). No raw
// IP is ever stored or shown.
export function LoginsTable({ rows }: { rows: LoginRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="panel px-3 py-6 text-center font-mono text-sm text-[var(--zinc-500)]">
        {"// no sign-in activity recorded yet"}
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
              <th>Result</th>
              <th>Method / Reason</th>
              <th>Location</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const denied = r.action === "auth.denied";
              return (
                <tr key={r.id}>
                  <td className="t-mono whitespace-nowrap">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="t-dim">{r.actorEmail ?? "—"}</td>
                  <td>
                    <span className={"badge " + (denied ? "badge-bad" : "badge-ok")}>
                      {denied ? "Denied" : "Login"}
                    </span>
                  </td>
                  <td className="t-dim">{r.detail ?? "—"}</td>
                  <td className="t-dim">{r.location ?? "—"}</td>
                  <td className="t-dim">{formatUserAgent(r.userAgent) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
