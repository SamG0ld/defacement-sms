import type { CategoryReconciliation } from "@/lib/equipment";

import {
  ASSET_COUNT_FIELDS,
  CountCells,
  type InvCounts,
} from "./CountEditor";
import { EquipmentManageRow } from "./EquipmentManageRow";
import { NeedHaveBar } from "./NeedHaveBar";

// Durable-hardware section. Default (view) mode is a glanceable per-category
// card — Need vs Have vs Gap with a gauge bar and the per-type on-hand
// breakdown. Edit mode (lead, ?edit=1) drops to the input grid for entering
// counts + item CRUD.

function invFromItem(item: {
  hasInventoryRow: boolean;
  onHand: number;
  endOfCon: number;
  ordered: number;
  received: number;
  notes: string | null;
}): InvCounts | undefined {
  if (!item.hasInventoryRow) return undefined;
  return {
    countStartOfCon: item.onHand,
    countEndOfCon: item.endOfCon,
    countOrdered: item.ordered,
    countReceived: item.received,
    notes: item.notes,
  };
}

export function AssetSection({
  reconciliation,
  year,
  canManage,
  edit,
}: {
  reconciliation: CategoryReconciliation[];
  year: number;
  canManage: boolean;
  edit: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-300">
        Hardware — need vs. have
      </h2>
      {reconciliation.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-sm text-zinc-500">
          No hardware items yet.
        </div>
      ) : edit && canManage ? (
        <EditGrid reconciliation={reconciliation} year={year} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {reconciliation.map((cat) => (
            <CategoryCard key={cat.category} cat={cat} />
          ))}
        </div>
      )}
    </section>
  );
}

function CategoryCard({ cat }: { cat: CategoryReconciliation }) {
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-zinc-200">{cat.category}s</h3>
        <div className="flex gap-3 text-xs text-zinc-400">
          {cat.need !== null && (
            <span>
              Need <strong className="text-zinc-200">{cat.need}</strong>
            </span>
          )}
          <span>
            Have <strong className="text-zinc-200">{cat.have}</strong>
          </span>
          {cat.gap !== null && cat.gap > 0 && (
            <span className="text-[var(--danger)]">
              Order <strong>{cat.gap}</strong>
            </span>
          )}
          {cat.gap === 0 && <span className="text-emerald-400">covered</span>}
        </div>
      </div>
      <NeedHaveBar have={cat.have} need={cat.need} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        {cat.items.map((item) => (
          <span key={item.id}>
            {item.name}{" "}
            <strong className="text-zinc-300">{item.effectiveOnHand}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function EditGrid({
  reconciliation,
  year,
}: {
  reconciliation: CategoryReconciliation[];
  year: number;
}) {
  const colSpan = 1 + ASSET_COUNT_FIELDS.length + 1 + 1;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Item</th>
            {ASSET_COUNT_FIELDS.map((f) => (
              <th key={f.key} className="px-3 py-2 font-medium">
                {f.label}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Notes</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {reconciliation.map((cat) => (
            <CategoryGroup
              key={cat.category}
              cat={cat}
              year={year}
              colSpan={colSpan}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryGroup({
  cat,
  year,
  colSpan,
}: {
  cat: CategoryReconciliation;
  year: number;
  colSpan: number;
}) {
  return (
    <>
      <tr className="bg-black/40">
        <td colSpan={colSpan} className="px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {/* Naive +"s" plural — safe because ASSET_CATEGORIES are all
                singular non-s words (Easel/Meterboard/Stand/Banner). */}
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
              {cat.category}s
            </span>
            <span className="text-xs text-zinc-400">
              Need:{" "}
              <strong className="text-zinc-200">
                {cat.need === null ? "—" : cat.need}
              </strong>
            </span>
            <span className="text-xs text-zinc-400">
              Have: <strong className="text-zinc-200">{cat.have}</strong>
            </span>
            {cat.gap !== null && (
              <span className="text-xs text-zinc-400">
                Gap:{" "}
                <strong
                  className={
                    cat.gap > 0 ? "text-[var(--danger)]" : "text-zinc-200"
                  }
                >
                  {cat.gap}
                </strong>
              </span>
            )}
          </div>
        </td>
      </tr>
      {cat.items.map((item) => (
        <tr key={item.id} className="align-middle text-zinc-200">
          <td className="px-3 py-2">
            <EquipmentManageRow
              typeId={item.id}
              year={year}
              name={item.name}
              category={item.category}
            />
          </td>
          <CountCells
            typeId={item.id}
            year={year}
            inv={invFromItem(item)}
            fields={ASSET_COUNT_FIELDS}
            canManage={true}
          />
        </tr>
      ))}
    </>
  );
}
