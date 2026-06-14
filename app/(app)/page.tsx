import Link from "next/link";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import type { SignStatus } from "@/app/generated/prisma/client";
import { TelemetryGauge } from "@/app/_components/TelemetryGauge";

import { DistBar } from "./signs/_components/DistBar";
import {
  SIGN_STATUSES,
  pacificTodayUtc,
  statusBadgeClass,
  statusLabel,
} from "./signs/_lib";

export default async function DashboardPage() {
  const session = await getSession();
  const today = pacificTodayUtc();

  const [grouped, total, dueToday, overdue] = await Promise.all([
    prisma.sign.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.sign.count(),
    prisma.sign.count({
      where: { status: { not: "deployed" }, deployByDate: today },
    }),
    prisma.sign.count({
      where: { status: { not: "deployed" }, deployByDate: { lt: today } },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  const countOf = (s: SignStatus): number => counts[s] ?? 0;
  // Match the signs/top-strip telemetry: "deployed" is the two up terminals
  // (deployed + externally installed).
  const deployedUp = countOf("deployed") + countOf("installed");
  const pct = total > 0 ? Math.round((deployedUp / total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <span className="prompt">DASHBOARD</span>
        <h1 className="mt-1.5 text-[24px] font-extrabold tracking-tight">
          Operations
        </h1>
        <p className="mt-1.5 flex items-center gap-2 text-sm text-zinc-500">
          <span>
            Signed in as{" "}
            <strong className="text-zinc-300">{session?.user?.email}</strong>
          </span>
          {session?.user?.role && (
            <span className="rolechip">{session.user.role}</span>
          )}
        </p>
      </div>

      {/* Deployment progress — telemetry gauge + workflow distribution */}
      <div className="panel" style={{ padding: "15px 18px" }}>
        <TelemetryGauge
          deployed={deployedUp}
          total={total}
          pct={pct}
          segments={40}
        />
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <DistBar counts={counts} total={total} />
          </div>
          <span
            className="whitespace-nowrap font-mono text-[10.5px]"
            style={{ color: "var(--zinc-500)" }}
          >
            {SIGN_STATUSES.length} stages
          </span>
        </div>
      </div>

      {/* Status breakdown — each tile links to that filtered list */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SIGN_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/signs?status=${s}`}
            className="panel flex flex-col gap-2 p-4 transition-colors hover:border-[var(--line-strong)]"
          >
            <span className={`badge ${statusBadgeClass(s)}`}>
              {statusLabel(s)}
            </span>
            <div
              className="font-mono text-2xl font-bold"
              style={{ color: "var(--foreground)" }}
            >
              {countOf(s)}
            </div>
          </Link>
        ))}
      </section>

      {/* Deploy-by urgency */}
      <section className="grid grid-cols-2 gap-3">
        <Link
          href="/signs?due=today"
          className="panel flex flex-col gap-1 p-4 transition-colors hover:border-[var(--line-strong)]"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--zinc-500)]">
            Due today
          </div>
          <div
            className="font-mono text-3xl font-bold"
            style={{ color: "var(--highlight)" }}
          >
            {dueToday}
          </div>
          <div className="text-xs text-zinc-500">not yet deployed</div>
        </Link>
        <Link
          href="/signs?due=overdue"
          className="flex flex-col gap-1 rounded-xl border p-4 transition-colors"
          style={
            overdue > 0
              ? {
                  borderColor:
                    "color-mix(in oklab, var(--danger) 50%, transparent)",
                  background: "var(--surface)",
                  boxShadow: "0 0 16px -6px var(--danger)",
                }
              : { borderColor: "var(--line)", background: "var(--surface)" }
          }
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--zinc-500)]">
            Overdue
          </div>
          <div
            className="font-mono text-3xl font-bold"
            style={{
              color: overdue > 0 ? "var(--danger)" : "var(--foreground)",
            }}
          >
            {overdue}
          </div>
          <div className="text-xs text-zinc-500">past deploy-by date</div>
        </Link>
      </section>

      <Link href="/signs" className="btn">
        View all signs →
      </Link>
    </div>
  );
}
