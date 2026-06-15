import Link from "next/link";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import type { SignStatus } from "@/app/generated/prisma/client";
import { TelemetryGauge } from "@/app/_components/TelemetryGauge";

import { DistBar } from "./signs/_components/DistBar";
import { SIGN_STATUSES, pacificTodayUtc } from "./signs/_lib";

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
      <div className="df-rise">
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

      {/* Deployment progress — telemetry gauge + workflow distribution. The
          gauge + 8-segment DistBar already tell the full status story, so the
          old per-status tile wall is gone (M13 de-box). */}
      <div
        className="df-rise panel"
        style={{ padding: "15px 18px", animationDelay: "0.06s" }}
      >
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

      {/* Deploy-by urgency — one slim line (overdue glows danger when > 0). */}
      <div
        className="df-rise flex flex-wrap items-center gap-x-6 gap-y-2"
        style={{ animationDelay: "0.12s" }}
      >
        <Link
          href="/signs?due=today"
          className="inline-flex items-baseline gap-2 transition-opacity hover:opacity-80"
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em]"
            style={{ color: "var(--zinc-500)" }}
          >
            Due today
          </span>
          <span
            className="font-mono text-lg font-bold"
            style={{
              color: dueToday > 0 ? "var(--highlight)" : "var(--foreground)",
            }}
          >
            {dueToday}
          </span>
        </Link>
        <span className="h-4 w-px" style={{ background: "var(--line-strong)" }} />
        <Link
          href="/signs?due=overdue"
          className="inline-flex items-baseline gap-2 transition-opacity hover:opacity-80"
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em]"
            style={{ color: "var(--zinc-500)" }}
          >
            Overdue
          </span>
          <span
            className="font-mono text-lg font-bold"
            style={{
              color: overdue > 0 ? "var(--danger)" : "var(--foreground)",
            }}
          >
            {overdue}
          </span>
        </Link>
      </div>

      <div className="df-rise" style={{ animationDelay: "0.18s" }}>
        <Link href="/signs" className="btn">
          View all signs →
        </Link>
      </div>
    </div>
  );
}
