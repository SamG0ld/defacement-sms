import Link from "next/link";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";

import { PagerLink } from "../signs/_components/PagerLink";
import { AuditTable, type AuditRow } from "./_components/AuditTable";
import { DeployTable, type DeployRow } from "./_components/DeployTable";
import { StatusTable, type StatusRow } from "./_components/StatusTable";

const PAGE_SIZE = 50;

type ActivityView = "audit" | "status" | "deploy";

type ActivityPageProps = {
  searchParams: Promise<{ view?: string; page?: string; action?: string }>;
};

export default async function ActivityPage({ searchParams }: ActivityPageProps) {
  // Lead+ can see the activity log (the (app) layout already guarantees an
  // authenticated active session).
  await requireRole("lead");

  const sp = await searchParams;
  const view: ActivityView =
    sp.view === "status" ? "status" : sp.view === "deploy" ? "deploy" : "audit";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const action =
    typeof sp.action === "string" && sp.action ? sp.action : undefined;
  const skip = (page - 1) * PAGE_SIZE;

  let total = 0;
  let auditRows: AuditRow[] = [];
  let statusRows: StatusRow[] = [];
  let deployRows: DeployRow[] = [];

  if (view === "audit") {
    const where = action ? { action } : {};
    [total, auditRows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: PAGE_SIZE,
        select: {
          id: true,
          action: true,
          actorEmail: true,
          detail: true,
          createdAt: true,
        },
      }),
    ]);
  } else if (view === "deploy") {
    let events: {
      id: number;
      clientId: string;
      signId: number;
      status: string;
      deployedByEmail: string | null;
      deployedAt: Date;
      notes: string | null;
      photoUrl: string | null;
    }[];
    [total, events] = await Promise.all([
      prisma.deployEvent.count(),
      prisma.deployEvent.findMany({
        orderBy: { deployedAt: "desc" },
        skip,
        take: PAGE_SIZE,
        select: {
          id: true,
          clientId: true,
          signId: true,
          status: true,
          deployedByEmail: true,
          deployedAt: true,
          notes: true,
          photoUrl: true,
        },
      }),
    ]);
    // DeployEvent is FK-free (it outlives the sign), so resolve sign labels with
    // a separate lookup and tolerate deletions.
    const signIds = [...new Set(events.map((e) => e.signId))];
    const signs =
      signIds.length > 0
        ? await prisma.sign.findMany({
            where: { id: { in: signIds } },
            select: { id: true, itemId: true, signText: true },
          })
        : [];
    const signById = new Map(signs.map((s) => [s.id, s]));
    deployRows = events.map((e) => ({
      id: e.id,
      clientId: e.clientId,
      signId: e.signId,
      status: e.status,
      deployedByEmail: e.deployedByEmail,
      deployedAt: e.deployedAt,
      notes: e.notes,
      hasPhoto: e.photoUrl !== null,
      sign: signById.get(e.signId) ?? null,
    }));
  } else {
    [total, statusRows] = await Promise.all([
      prisma.statusHistory.count(),
      prisma.statusHistory.findMany({
        orderBy: { changedAt: "desc" },
        skip,
        take: PAGE_SIZE,
        select: {
          id: true,
          oldStatus: true,
          newStatus: true,
          changedBy: true,
          changedAt: true,
          sign: { select: { id: true, itemId: true, signText: true } },
        },
      }),
    ]);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const baseQuery = new URLSearchParams({
    view,
    ...(action ? { action } : {}),
  }).toString();

  const tab = (key: ActivityView, label: string) => {
    const active = view === key;
    return (
      <Link
        href={`/activity?view=${key}`}
        className={`rounded-t border-b-2 px-3 py-1.5 text-sm ${
          active
            ? "border-accent text-zinc-100"
            : "border-transparent text-zinc-400 hover:text-zinc-200"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-zinc-400">
          Who did what — admin events and sign status changes. Newest first.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-zinc-800">
        {tab("audit", "Admin events")}
        {tab("status", "Status changes")}
        {tab("deploy", "Deploys")}
      </div>

      {view === "audit" ? (
        <AuditTable rows={auditRows} />
      ) : view === "deploy" ? (
        <DeployTable rows={deployRows} />
      ) : (
        <StatusTable rows={statusRows} />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-400">
          <PagerLink
            page={page - 1}
            disabled={page <= 1}
            baseQuery={baseQuery}
            label="← Prev"
            basePath="/activity"
          />
          <span>
            Page {page} of {totalPages}
          </span>
          <PagerLink
            page={page + 1}
            disabled={page >= totalPages}
            baseQuery={baseQuery}
            label="Next →"
            basePath="/activity"
          />
        </div>
      )}
    </div>
  );
}
