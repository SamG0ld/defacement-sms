import Link from "next/link";

import { requirePageSession } from "@/lib/page-guards";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/rbac";
import { SYSTEM_TAG_SLUG_LIST } from "@/lib/tags";
import { Icons } from "@/app/_components/Icons";
import { TelemetryGauge } from "@/app/_components/TelemetryGauge";

import {
  DEPLOYMENT_SLOTS,
  SIGN_CATEGORIES,
  SIGN_CATEGORY_LABELS,
  SIGN_STATUSES,
  buildSignWhere,
  shortZoneLabel,
} from "./_lib";
import { BulkBar, SelectionProvider } from "./_selection";
import { DistBar } from "./_components/DistBar";
import { FilterChips } from "./_components/FilterChips";
import { PagerLink } from "./_components/PagerLink";
import { SearchField } from "./_components/SearchField";
import { SignCards } from "./_components/SignCards";
import { SignsTable } from "./_components/SignsTable";
import { SignsView } from "./_components/SignsView";
import { groupSignRows } from "./_components/grouping";
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
  notice?: string;
}>;

function firstStr(v: string | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

// The signType dropdown's DISTINCT scan doesn't need to run on every list load —
// the set of types changes only on import/edit, so memo it per server instance
// with a short TTL. Worst case: a brand-new type takes up to 60s to appear in
// the filter dropdown. The in-flight promise is memoed too, so concurrent
// requests that both miss the TTL share one query instead of double-fetching.
let signTypesMemo: { value: string[]; expires: number } | null = null;
let signTypesInFlight: Promise<string[]> | null = null;

async function getSignTypes(): Promise<string[]> {
  if (signTypesMemo && Date.now() < signTypesMemo.expires) {
    return signTypesMemo.value;
  }
  if (signTypesInFlight) return signTypesInFlight;
  signTypesInFlight = (async () => {
    const rows = await prisma.sign.findMany({
      distinct: ["signType"],
      orderBy: { signType: "asc" },
      select: { signType: true },
    });
    const value = rows.map((r) => r.signType).filter(Boolean);
    signTypesMemo = { value, expires: Date.now() + 60_000 };
    return value;
  })();
  try {
    return await signTypesInFlight;
  } finally {
    signTypesInFlight = null;
  }
}

// Serialize the active filters back into a query string (used by the pager, the
// status chips, and the per-row status forms so a status change returns to the
// same view). Never emits `page`, so it always lands on page 1.
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
  const session = await requirePageSession();
  const canManage = hasRole(session.user.role, "lead");
  const isAdmin = session.user.role === "admin";

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
  const notice = firstStr(sp.notice);
  const page = Math.max(1, Number.parseInt(firstStr(sp.page) || "1", 10) || 1);

  // The list query honours every active filter; the per-status counts that feed
  // the chips + telemetry honour the list filters EXCEPT status (so the chips show
  // the full stage distribution within the current view) and EXCEPT `due`. `due`
  // is a dashboard urgency shortcut that forces `status != deployed` inside
  // buildSignWhere — leaving it in would zero the gauge's deployed count and make
  // the readout lie, so telemetry/chips ignore it (the list still honours it).
  const where = buildSignWhere(f);
  const whereCounts = buildSignWhere({ ...f, status: "", due: "" });

  const [allRows, statusGroups, zones, tags, signTypes, archivedCount] =
    await Promise.all([
    // The whole filtered set (not a row page): identical signs are collapsed into
    // groups and the list paginates over GROUPS, so a group can't be split across a
    // page boundary. Bounded to a con's few hundred signs — see groupSignRows.
    prisma.sign.findMany({
      where,
      select: signRowSelect,
      orderBy: [{ deploymentPriority: "asc" }, { itemId: "asc" }],
    }),
    prisma.sign.groupBy({
      by: ["status"],
      where: whereCounts,
      _count: { _all: true },
    }),
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: { id: true, zoneCode: true, zoneName: true, building: true },
    }),
    prisma.signTag.findMany({
      // Hide system tags (e.g. `master-sheet`) from the filter chips — they're
      // internal scoping markers, not user-curated labels (lib/tags.ts).
      where: { slug: { notIn: SYSTEM_TAG_SLUG_LIST } },
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true },
    }),
    getSignTypes(),
    // Count of soft-removed signs — drives the "Removed" filter chip (which
    // otherwise wouldn't appear, since archived is out of SIGN_STATUSES).
    prisma.sign.count({ where: { status: "archived" } }),
  ]);

  // `total` is the true count of physical signs (rows) — the headline number. The
  // list itself paginates over collapsed GROUPS.
  const total = allRows.length;
  const allGroups = groupSignRows(allRows);
  const totalPages = Math.max(1, Math.ceil(allGroups.length / PAGE_SIZE));
  const groups = allGroups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Per-stage counts → telemetry. "deployed" telemetry counts the two terminal
  // up-states (deployed + externally installed).
  const counts: Record<string, number> = {};
  for (const g of statusGroups) counts[g.status] = g._count._all;
  const grandTotal = SIGN_STATUSES.reduce(
    (acc, s) => acc + (counts[s] ?? 0),
    0,
  );
  const deployedCount = (counts.deployed ?? 0) + (counts.installed ?? 0);
  const deployPct = grandTotal
    ? Math.round((deployedCount / grandTotal) * 100)
    : 0;

  const baseQuery = filterQuery(f);
  // Other active filters minus the search term — drives the live SearchField so a
  // search preserves status/zone/tag/etc. (filterQuery never emits `page`, and
  // buildSearchHref also drops it, so a new search lands on page 1).
  const searchOtherParams = filterQuery({ ...f, q: "" });
  // Href for a status chip: current filters with `status` set (or cleared), and
  // `due` dropped (chips are a pure status filter — clicking one escapes the
  // dashboard urgency shortcut), page dropped. Reuses filterQuery so it stays in
  // lockstep with the pager/forms.
  const hrefForStatus = (status: string) => {
    const qs = filterQuery({ ...f, status, due: "" });
    return qs ? `/signs?${qs}` : "/signs";
  };
  const secondaryActive = !!(
    f.zone ||
    f.tag ||
    f.slot ||
    f.type ||
    f.category
  );

  // Props for the selection island / bulk bar. returnTo keeps the user on this
  // exact filtered + paged view after a bulk action revalidates.
  const pageIds = groups.flatMap((g) => g.rows.map((r) => r.id));
  const returnParams = new URLSearchParams(baseQuery);
  if (page > 1) returnParams.set("page", String(page));
  const returnTo = `/signs${returnParams.toString() ? `?${returnParams.toString()}` : ""}`;
  const zoneOptions = zones.map((z) => ({ id: z.id, label: shortZoneLabel(z) }));
  const tagOptions = tags.map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <span className="prompt">SIGNS</span>
          <div className="mt-1.5 flex items-baseline gap-2.5">
            <h1 className="text-[24px] font-extrabold tracking-tight">Signs</h1>
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--zinc-500)" }}
            >
              {baseQuery ? `${total} / ${grandTotal}` : `${total} records`}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="searchbox">
            <span className="ic">
              <Icons.search width={15} height={15} />
            </span>
            <SearchField
              defaultValue={f.q}
              otherParams={searchOtherParams}
              className=""
            />
          </div>
          <Link
            href={`/signs/export${baseQuery ? `?${baseQuery}` : ""}`}
            className="btn"
          >
            Export CSV
          </Link>
          <Link
            href={`/signs/export/sectioned${baseQuery ? `?${baseQuery}` : ""}`}
            className="btn"
            title="Human-audit CSV grouped into === FORMAT === sections by size (not re-importable)"
          >
            Export by size
          </Link>
          <Link
            href="/signs/by-size"
            className="btn"
            title="The complete record of active signs per size, plus the Figma reconcile manifest"
          >
            By size
          </Link>
          {isAdmin && (
            <>
              <Link href="/signs/manage" className="btn">
                Manage
              </Link>
              <Link href="/signs/pin" className="btn">
                Auto-pin
              </Link>
            </>
          )}
          {canManage && (
            <>
              <Link href="/signs/generate" className="btn">
                Generation
              </Link>
              <Link href="/signs/import" className="btn">
                Import
              </Link>
              <Link href="/signs/reconcile" className="btn">
                Reconcile
              </Link>
              <Link href="/signs/specialty" className="btn">
                Specialty
              </Link>
              <Link href="/signs/new" className="btn btn-primary">
                + New sign
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

      {notice && (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-xs text-emerald-200">
          {notice}
        </div>
      )}

      {/* Telemetry */}
      <div className="panel" style={{ padding: "15px 18px" }}>
        <TelemetryGauge
          deployed={deployedCount}
          total={grandTotal}
          pct={deployPct}
          segments={34}
        />
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <DistBar counts={counts} total={grandTotal} />
          </div>
          <span
            className="whitespace-nowrap font-mono text-[10.5px]"
            style={{ color: "var(--zinc-500)" }}
          >
            {SIGN_STATUSES.length} stages
          </span>
        </div>
      </div>

      {/* Status filter chips */}
      <FilterChips
        active={f.status}
        counts={counts}
        total={grandTotal}
        archivedCount={archivedCount}
        hrefForStatus={hrefForStatus}
      />

      {/* Secondary filters (zone / tag / slot / type / category) — tucked into a
          disclosure so the default view stays clean; auto-opens when one is set.
          A GET form that carries the active status + search as hidden inputs so
          applying a secondary filter preserves the current chip and search. */}
      <details
        open={secondaryActive}
        className="rounded-lg border border-[var(--line)] bg-[var(--surface)]"
      >
        <summary className="cursor-pointer select-none px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--zinc-400)] hover:text-[var(--foreground)]">
          More filters{secondaryActive ? " · active" : ""}
        </summary>
        <form
          method="get"
          className="grid grid-cols-2 gap-3 border-t border-[var(--line)] p-4 md:grid-cols-3 lg:grid-cols-5"
        >
          <input type="hidden" name="status" value={f.status} />
          <input type="hidden" name="q" value={f.q} />
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Zone
            <select
              name="zone"
              defaultValue={f.zone}
              className="field"
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
              className="field"
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
              className="field"
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
              className="field"
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
              className="field"
            >
              <option value="">All</option>
              {SIGN_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SIGN_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 flex items-center gap-2 md:col-span-3 lg:col-span-5">
            <button type="submit" className="btn btn-primary">
              Apply filters
            </button>
            {baseQuery && (
              <Link href="/signs" className="btn">
                Clear
              </Link>
            )}
          </div>
        </form>
      </details>

      {groups.length === 0 ? (
        <div className="panel px-4 py-10 text-center font-mono text-sm text-[var(--zinc-500)]">
          {"// no signs match these filters"}
        </div>
      ) : (
        <SelectionProvider pageIds={pageIds} total={total}>
          {/* Both subtrees are server-rendered; SignsView mounts only one of
              them on the client per the device signal (fewer hydrated rows than
              the old md:hidden / hidden-md:block double-DOM). */}
          <SignsView
            table={<SignsTable groups={groups} />}
            cards={<SignCards groups={groups} />}
          />

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
