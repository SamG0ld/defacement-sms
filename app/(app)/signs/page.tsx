import Link from "next/link";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/rbac";

import {
  DEPLOYMENT_SLOTS,
  SIGN_CATEGORIES,
  SIGN_CATEGORY_LABELS,
  SIGN_STATUSES,
  buildSignWhere,
  shortZoneLabel,
} from "./_lib";
import { BulkBar, SelectionProvider } from "./_selection";
import { PagerLink } from "./_components/PagerLink";
import { SearchField } from "./_components/SearchField";
import { SignCards } from "./_components/SignCards";
import { SignsTable } from "./_components/SignsTable";
import { signRowSelect } from "./_components/types";

const PAGE_SIZE = 50;

type SearchParams = Promise<{
  status?: string;
  zone?: string;
  tag?: string;
  slot?: string;
  type?: string;
  category?: string;
  q?: string;
  due?: string;
  page?: string;
  error?: string;
}>;

function firstStr(v: string | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

// Serialize the active filters back into a query string (used by the pager and
// the per-row status forms so a status change returns to the same view).
function filterQuery(f: {
  status: string;
  zone: string;
  tag: string;
  slot: string;
  type: string;
  category: string;
  q: string;
  due: string;
}): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.zone) p.set("zone", f.zone);
  if (f.tag) p.set("tag", f.tag);
  if (f.slot) p.set("slot", f.slot);
  if (f.type) p.set("type", f.type);
  if (f.category) p.set("category", f.category);
  if (f.q) p.set("q", f.q);
  if (f.due) p.set("due", f.due);
  return p.toString();
}

export default async function SignsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getSession();
  const canManage = session?.user?.role
    ? hasRole(session.user.role, "lead")
    : false;
  const isAdmin = session?.user?.role === "admin";

  const sp = await searchParams;
  const f = {
    status: firstStr(sp.status),
    zone: firstStr(sp.zone),
    tag: firstStr(sp.tag),
    slot: firstStr(sp.slot),
    type: firstStr(sp.type),
    category: firstStr(sp.category),
    q: firstStr(sp.q),
    due: firstStr(sp.due),
  };
  const error = firstStr(sp.error);
  const page = Math.max(1, Number.parseInt(firstStr(sp.page) || "1", 10) || 1);

  // Build the Prisma filter from the active params (shared with CSV export).
  const where = buildSignWhere(f);

  const [signs, total, zones, tags, typeRows] = await Promise.all([
    prisma.sign.findMany({
      where,
      select: signRowSelect,
      orderBy: [{ deploymentPriority: "asc" }, { itemId: "asc" }],
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.sign.count({ where }),
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: { id: true, zoneCode: true, zoneName: true, building: true },
    }),
    prisma.signTag.findMany({
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true },
    }),
    prisma.sign.findMany({
      distinct: ["signType"],
      orderBy: { signType: "asc" },
      select: { signType: true },
    }),
  ]);

  const signTypes = typeRows.map((r) => r.signType).filter(Boolean);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const baseQuery = filterQuery(f);
  // Other active filters minus the search term — drives the live SearchField so a
  // search preserves status/zone/tag/etc. (filterQuery never emits `page`, and
  // buildSearchHref also drops it, so a new search lands on page 1).
  const searchOtherParams = filterQuery({ ...f, q: "" });

  // Props for the selection island / bulk bar. returnTo keeps the user on this
  // exact filtered + paged view after a bulk action revalidates.
  const pageIds = signs.map((s) => s.id);
  const returnParams = new URLSearchParams(baseQuery);
  if (page > 1) returnParams.set("page", String(page));
  const returnTo = `/signs${returnParams.toString() ? `?${returnParams.toString()}` : ""}`;
  const zoneOptions = zones.map((z) => ({ id: z.id, label: shortZoneLabel(z) }));
  const tagOptions = tags.map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Signs</h1>
          <p className="text-sm text-zinc-400">
            {total} sign{total === 1 ? "" : "s"}
            {baseQuery ? " (filtered)" : ""}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/signs/export${baseQuery ? `?${baseQuery}` : ""}`}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Export CSV
          </Link>
          {isAdmin && (
            <Link
              href="/signs/manage"
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Manage
            </Link>
          )}
          {canManage && (
            <>
              <Link
                href="/signs/generate"
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Generation
              </Link>
              <Link
                href="/signs/import"
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Import
              </Link>
              <Link
                href="/signs/new"
                className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
              >
                New sign
              </Link>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* GET filter form — the selects submit via "Apply filters" (reloads with
          updated params). The Search field is live (debounced soft-nav) but keeps
          name="q" so it still degrades to a normal form submit without JS. */}
      <form
        method="get"
        className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 md:grid-cols-3 lg:grid-cols-6"
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Status
          <select
            name="status"
            defaultValue={f.status}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {SIGN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Zone
          <select
            name="zone"
            defaultValue={f.zone}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {zones.map((z) => (
              <option key={z.id} value={String(z.id)}>
                {shortZoneLabel(z)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Tag
          <select
            name="tag"
            defaultValue={f.tag}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {tags.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Slot
          <select
            name="slot"
            defaultValue={f.slot}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {DEPLOYMENT_SLOTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Type
          <select
            name="type"
            defaultValue={f.type}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {signTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Category
          <select
            name="category"
            defaultValue={f.category}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">All</option>
            {SIGN_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {SIGN_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Search
          <SearchField defaultValue={f.q} otherParams={searchOtherParams} />
        </label>
        <div className="col-span-2 flex items-center gap-2 md:col-span-3 lg:col-span-6">
          <button
            type="submit"
            className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
          >
            Apply filters
          </button>
          {baseQuery && (
            <Link
              href="/signs"
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {signs.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-10 text-center text-sm text-zinc-500">
          No signs match these filters.
        </div>
      ) : (
        <SelectionProvider pageIds={pageIds} total={total}>
          <SignsTable signs={signs} />
          <SignCards signs={signs} />

          <BulkBar
            canManage={canManage}
            filters={f}
            returnTo={returnTo}
            zones={zoneOptions}
            tags={tagOptions}
          />
        </SelectionProvider>
      )}

      {/* Pager */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-400">
          <PagerLink
            page={page - 1}
            disabled={page <= 1}
            baseQuery={baseQuery}
            label="← Prev"
          />
          <span>
            Page {page} of {totalPages}
          </span>
          <PagerLink
            page={page + 1}
            disabled={page >= totalPages}
            baseQuery={baseQuery}
            label="Next →"
          />
        </div>
      )}
    </div>
  );
}
