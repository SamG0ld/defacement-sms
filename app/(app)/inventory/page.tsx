import { CON_YEAR, conLabelForYear } from "@/lib/con-config";
import { prisma } from "@/lib/db";
import {
  assetsToOrder,
  CATEGORY_OPTIONS,
  classifyKind,
  reconcileAssets,
  type AssetItem,
} from "@/lib/equipment";
import { computePrintSummary } from "@/lib/print-summary";
import { listQmGroups } from "@/lib/qm-stock";
import { hasRole } from "@/lib/rbac";
import { requirePageSession } from "@/lib/page-guards";

import { addEquipmentType, recordSignMaterialHistory } from "./actions";
import { AssetSection } from "./_components/AssetSection";
import {
  ConsumablesSection,
  type ConsumableRow,
} from "./_components/ConsumablesSection";
import { type InvCounts } from "./_components/CountEditor";
import { PrintSummarySection } from "./_components/PrintSummarySection";
import { QmStockSection } from "./_components/QmStockSection";
import { YearOverYear } from "./_components/YearOverYear";

type SearchParams = Promise<{ year?: string; error?: string; edit?: string }>;

type InvRow = {
  countStartOfCon: number;
  countEndOfCon: number;
  countOrdered: number;
  countReceived: number;
  notes: string | null;
} | null;

function invCounts(row: InvRow): InvCounts | undefined {
  return row
    ? {
        countStartOfCon: row.countStartOfCon,
        countEndOfCon: row.countEndOfCon,
        countOrdered: row.countOrdered,
        countReceived: row.countReceived,
        notes: row.notes,
      }
    : undefined;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requirePageSession();
  const canManage = hasRole(session.user.role, "lead");

  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : "";
  // Default to the con currently being worked (CON_YEAR), not the calendar year —
  // that's the con whose signs are loaded and whose counts you're editing.
  const year =
    Number.parseInt(typeof sp.year === "string" ? sp.year : "", 10) || CON_YEAR;
  const edit = sp.edit === "1" && canManage;

  const [types, history, sizeGroups, qmGroups] = await Promise.all([
    prisma.equipmentType.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { inventory: { where: { year } } },
    }),
    prisma.equipmentInventory.findMany({
      orderBy: { year: "asc" },
      include: { equipmentType: { select: { name: true, category: true } } },
    }),
    // Aggregate in the DB so the print summary stays cheap as signs grow.
    // Exclude archived (soft-removed) signs — a removed sign must not count
    // toward what to print or how much hardware to order (buildSignWhere isn't
    // reachable from a raw groupBy-by shape, so the exclusion is explicit).
    prisma.sign.groupBy({
      by: ["category", "size", "doubleSided", "needsEasel", "printable"],
      where: { status: { not: "archived" } },
      _sum: { quantity: true },
    }),
    // QM pile rollup: each group of identical signs (size > 1) with Total / Out /
    // Remaining. Take/return N is available here and on each sign's detail page.
    listQmGroups(),
  ]);

  // Derived "print summary" — sheet 6's auto-counts, recomputed from the signs.
  // Counts are per category: easels honor the Easel Y/N flag, meterboard stands
  // come from the meterboard category, prints exclude bare easels (see computePrintSummary).
  const summary = computePrintSummary(
    sizeGroups.map((g) => ({
      category: g.category,
      size: g.size,
      doubleSided: g.doubleSided,
      needsEasel: g.needsEasel,
      printable: g.printable,
      quantity: g._sum.quantity ?? 0,
    })),
  );

  // Prior year's end-of-con per type — the carry-forward default for "have".
  const priorEnd = new Map<number, number>();
  for (const h of history) {
    if (h.year === year - 1) priorEnd.set(h.equipmentTypeId, h.countEndOfCon);
  }

  // Split the catalog into the three sections by derived kind.
  const assetItems: AssetItem[] = [];
  const consumables: ConsumableRow[] = [];
  for (const t of types) {
    const kind = classifyKind(t.category);
    if (kind === "sign_material") continue; // history-only; shown in YoY
    const row = (t.inventory[0] ?? null) as InvRow;
    if (kind === "asset") {
      assetItems.push({
        id: t.id,
        name: t.name,
        category: t.category ?? "Other",
        onHand: row?.countStartOfCon ?? 0,
        priorEndOfCon: priorEnd.has(t.id) ? priorEnd.get(t.id)! : null,
        ordered: row?.countOrdered ?? 0,
        received: row?.countReceived ?? 0,
        endOfCon: row?.countEndOfCon ?? 0,
        notes: row?.notes ?? null,
        hasInventoryRow: Boolean(row),
      });
    } else {
      consumables.push({
        id: t.id,
        name: t.name,
        category: t.category,
        inv: invCounts(row),
      });
    }
  }

  const reconciliation = reconcileAssets(assetItems, {
    Easel: summary.easelsRequired,
    Meterboard: summary.meterboardStands,
  });
  const toOrder = assetsToOrder(reconciliation);

  const years = [CON_YEAR + 1, CON_YEAR, CON_YEAR - 1, CON_YEAR - 2, CON_YEAR - 3];
  const baseHref = `/inventory?year=${year}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="prompt">INVENTORY</span>
          <h1 className="mt-1.5 text-[24px] font-extrabold tracking-tight">
            Inventory &amp; counts
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            What to print (live), hardware need vs. have, consumables, and
            year-over-year history.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2">
            {edit && <input type="hidden" name="edit" value="1" />}
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Con
              <select
                name="year"
                defaultValue={String(year)}
                className="field"
              >
                {years.map((y) => (
                  <option key={y} value={String(y)}>
                    {conLabelForYear(y)} ({y})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">
              View
            </button>
          </form>
          {canManage && (
            <a
              href={edit ? baseHref : `${baseHref}&edit=1`}
              className={edit ? "btn btn-primary" : "btn"}
            >
              {edit ? "Done editing" : "Edit counts"}
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Actionable rollup: what to buy. View mode only. */}
      {!edit && toOrder.length > 0 && (
        <div className="panel px-4 py-3 text-sm text-zinc-300">
          <span className="font-medium text-[var(--danger)]">To order:</span>{" "}
          {toOrder
            .map(
              (o) =>
                `${o.gap} ${o.category.toLowerCase()}${o.gap === 1 ? "" : "s"}`,
            )
            .join(" · ")}
        </div>
      )}

      {edit && (
        <form
          action={addEquipmentType}
          className="panel flex flex-wrap items-end gap-3 p-4"
        >
          <input type="hidden" name="year" value={year} />
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            New item
            <input
              name="name"
              required
              placeholder="e.g. Spider Easels"
              className="field w-56"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Category
            <select
              name="category"
              defaultValue="Consumable"
              className="field"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary">
            Add item
          </button>
        </form>
      )}

      <PrintSummarySection summary={summary} />

      <QmStockSection rows={qmGroups} />

      <AssetSection
        reconciliation={reconciliation}
        year={year}
        canManage={canManage}
        edit={edit}
      />

      <ConsumablesSection
        items={consumables}
        year={year}
        canManage={canManage}
        edit={edit}
      />

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span />
          {canManage && summary.totalSigns > 0 && (
            <form action={recordSignMaterialHistory.bind(null, year)}>
              <button
                type="submit"
                className="btn btn-sm"
                title={`Snapshot the current ${summary.totalSigns} signs' material totals into ${conLabelForYear(year)} history`}
              >
                Record {conLabelForYear(year)} sign totals → history
              </button>
            </form>
          )}
        </div>
        <YearOverYear history={history} />
      </div>
    </div>
  );
}
