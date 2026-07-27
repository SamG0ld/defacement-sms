import Link from "next/link";

import { prisma } from "@/lib/db";
import { requirePageRole } from "@/lib/page-guards";

import { PagerLink } from "../signs/_components/PagerLink";
import { AuditTable, type AuditRow } from "./_components/AuditTable";
import { DeployTable, type DeployRow } from "./_components/DeployTable";
import { LoginsTable, type LoginRow } from "./_components/LoginsTable";
import { StatusTable, type StatusRow } from "./_components/StatusTable";

const PAGE_SIZE = 50;

// Authentication events live on the admin-only Logins tab; they are excluded
// from the lead-visible "Admin events" tab so their location / device / denied
// email never surfaces there.
const AUTH_ACTIONS = ["auth.login", "auth.denied"];

type ActivityView = "audit" | "status" | "deploy" | "logins";

type ActivityPageProps = {
  searchParams: Promise<{ view?: string; page?: string; action?: string }>;
};

export default async function ActivityPage({ searchParams }: ActivityPageProps) {
  // Lead+ can see the activity log (the (app) layout already guarantees an
  // authenticated active session).
  const session = await requirePageRole("lead");
  const isAdmin = session.user.role === "admin";

  const sp = await searchParams;
  const view: ActivityView =
    sp.view === "status"
      ? "status"
      : sp.view === "deploy"
        ? "deploy"
        : sp.view === "logins"
          ? "logins"
          : "audit";

  // The Logins tab exposes coarse location + device (PII) — admin-only, even
  // though the rest of /activity is lead+. A lead landing here is bounced back to
  // the default activity view rather than shown an error.
  if (view === "logins") await requirePageRole("admin", "/activity");
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const action =
    typeof sp.action === "string" && sp.action ? sp.action : undefined;
  const skip = (page - 1) * PAGE_SIZE;

  let total = 0;
  let auditRows: AuditRow[] = [];
  let statusRows: StatusRow[] = [];
  let deployRows: DeployRow[] = [];
  let loginRows: LoginRow[] = [];

  if (view === "audit") {
    // Filter to a specific non-auth action if requested; otherwise list all
    // admin events. Either way exclude auth.* — including stripping an auth.*
    // value passed via ?action= so a lead can't surface login rows here.
    const where =
      action && !AUTH_ACTIONS.includes(action)
        ? { action }
        : { action: { notIn: AUTH_ACTIONS } };
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
  } else if (view === "logins") {
    const where = { action: { in: AUTH_ACTIONS } };
    [total, loginRows] = await Promise.all([
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
          location: true,
          userAgent: true,
          createdAt: true,
        },
      }),
    ]);
  } else {
    [total, statusRows] = await Promise.all([
      prisma.statusHistory.count(),
      prisma.statusHistory.findMany({
        orderBy: { changedAt: "desc" },
        skip,
        take: PAGE_SIZE,
        select: {
          id: true,
          changeType: true,
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

  const tab = (key: ActivityView, label: string) => (
    <Link
      href={`/activity?view=${key}`}
      aria-current={view === key ? "page" : undefined}
      className={"chip" + (view === key ? " active" : "")}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div>
        <span className="prompt">ACTIVITY</span>
        <h1 className="mt-1.5 text-[24px] font-extrabold tracking-tight">
          Activity log
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Who did what — admin events and sign status/format changes. Newest first.
        </p>
      </div>

      <nav className="chiprow" aria-label="Activity view">
        {tab("audit", "Admin events")}
        {tab("status", "Change history")}
        {tab("deploy", "Deploys")}
        {isAdmin && tab("logins", "Logins")}
      </nav>

      {view === "audit" ? (
        <AuditTable rows={auditRows} />
      ) : view === "deploy" ? (
        <DeployTable rows={deployRows} />
      ) : view === "logins" ? (
        <LoginsTable rows={loginRows} />
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
