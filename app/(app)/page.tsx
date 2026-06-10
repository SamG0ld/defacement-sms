import Link from "next/link";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import type { SignStatus } from "@/app/generated/prisma/client";

import {
  SIGN_STATUSES,
  pacificTodayUtc,
  statusBadgeClass,
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

  const countOf = (s: SignStatus): number =>
    grouped.find((g) => g.status === s)?._count._all ?? 0;
  const deployed = countOf("deployed");
  const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-zinc-500">
          Signed in as <strong>{session?.user?.email}</strong> (
          {session?.user?.role}).
        </p>
      </div>

      {/* Deployment progress */}
      <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">
            Deployment progress
          </h2>
          <span className="text-sm text-zinc-400">
            {deployed} / {total} deployed ({pct}%)
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-brand transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </section>

      {/* Status breakdown — each tile links to that filtered list */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SIGN_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/signs?status=${s}`}
            className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-600"
          >
            <span
              className={`inline-block rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s)}`}
            >
              {s}
            </span>
            <div className="text-2xl font-semibold text-zinc-100">
              {countOf(s)}
            </div>
          </Link>
        ))}
      </section>

      {/* Deploy-by urgency */}
      <section className="grid grid-cols-2 gap-3">
        <Link
          href="/signs?due=today"
          className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-600"
        >
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Due today
          </div>
          <div className="text-2xl font-semibold text-highlight">
            {dueToday}
          </div>
          <div className="text-xs text-zinc-500">not yet deployed</div>
        </Link>
        <Link
          href="/signs?due=overdue"
          className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-600"
        >
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Overdue
          </div>
          <div
            className={`text-2xl font-semibold ${overdue > 0 ? "text-danger" : "text-zinc-100"}`}
          >
            {overdue}
          </div>
          <div className="text-xs text-zinc-500">past deploy-by date</div>
        </Link>
      </section>

      <Link
        href="/signs"
        className="inline-block text-sm text-accent hover:underline"
      >
        View all signs →
      </Link>
    </div>
  );
}
