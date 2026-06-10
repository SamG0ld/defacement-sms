import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

import { formatDateTime } from "../_lib";
import { clearAllSigns, clearTestSigns } from "./actions";

type SearchParams = Promise<{ error?: string; done?: string }>;

export default async function ManageSignsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getSession();
  // Admin-only — destructive bulk operations.
  if (session?.user?.role !== "admin") {
    redirect("/signs");
  }

  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : "";
  const doneMsg = typeof sp.done === "string" ? sp.done : "";

  const [total, testCount, audits] = await Promise.all([
    prisma.sign.count(),
    prisma.sign.count({ where: { isTestData: true } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const realCount = total - testCount;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Manage sign data</h1>
        <p className="text-sm text-zinc-400">
          Clear test data between runs, or fully reset the board before the final
          list. Every action here is logged below.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {doneMsg && (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-xs text-emerald-200">
          {doneMsg}
        </div>
      )}

      {/* Counts */}
      <div className="flex flex-wrap gap-3 text-sm">
        <Stat label="Total signs" value={total} tone="text-zinc-200" />
        <Stat label="Test signs" value={testCount} tone="text-yellow-300" />
        <Stat label="Real signs" value={realCount} tone="text-emerald-300" />
      </div>

      {/* Danger zone */}
      <section className="space-y-5 rounded-lg border border-red-900/60 bg-zinc-950 p-4">
        <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div className="text-sm text-zinc-300">
            <div className="font-medium">Clear test data</div>
            <div className="text-xs text-zinc-500">
              Deletes the {testCount} test sign{testCount === 1 ? "" : "s"} (samples
              + imports flagged “test”). Leaves the {realCount} real sign
              {realCount === 1 ? "" : "s"} untouched.
            </div>
          </div>
          <form action={clearTestSigns}>
            <button
              type="submit"
              disabled={testCount === 0}
              className="rounded border border-yellow-800 px-3 py-1.5 text-sm text-yellow-300 hover:bg-yellow-950 disabled:opacity-40"
            >
              Clear test data
            </button>
          </form>
        </div>

        <div className="space-y-2">
          <div className="text-sm text-zinc-300">
            <div className="font-medium text-red-300">Clear ALL signs</div>
            <div className="text-xs text-zinc-500">
              Permanently deletes every sign ({total}) regardless of flag. Type
              <span className="mx-1 rounded bg-zinc-800 px-1 font-mono text-zinc-200">
                DELETE ALL SIGNS
              </span>
              to confirm.
            </div>
          </div>
          <form action={clearAllSigns} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              name="confirm"
              autoComplete="off"
              placeholder="DELETE ALL SIGNS"
              className="w-56 rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
            <button
              type="submit"
              disabled={total === 0}
              className="btn-danger rounded px-3 py-1.5 text-sm disabled:opacity-40"
            >
              Clear ALL signs
            </button>
          </form>
        </div>
      </section>

      {/* Audit log */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Recent activity</h2>
        {audits.length === 0 ? (
          <p className="text-sm text-zinc-500">No logged actions yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                  <th className="px-3 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {audits.map((a) => (
                  <tr key={a.id} className="text-zinc-300">
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {formatDateTime(a.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{a.action}</td>
                    <td className="px-3 py-2">{a.detail ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {a.actorEmail ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}
