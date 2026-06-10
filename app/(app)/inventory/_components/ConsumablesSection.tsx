import {
  CONSUMABLE_COUNT_FIELDS,
  CountCells,
  type InvCounts,
} from "./CountEditor";
import { EquipmentManageRow } from "./EquipmentManageRow";

// Consumables / supplies: a flat, fully user-managed restock list. Default
// (view) mode is a compact on-hand readout; edit mode (lead, ?edit=1) is the
// input grid with item CRUD.

export type ConsumableRow = {
  id: number;
  name: string;
  category: string | null;
  inv: InvCounts | undefined;
};

export function ConsumablesSection({
  items,
  year,
  canManage,
  edit,
}: {
  items: ConsumableRow[];
  year: number;
  canManage: boolean;
  edit: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-300">
        Consumables &amp; supplies
      </h2>
      {items.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-sm text-zinc-500">
          No consumables yet. {canManage ? "Switch to edit mode to add some." : ""}
        </div>
      ) : edit && canManage ? (
        <EditGrid items={items} year={year} />
      ) : (
        <div className="flex flex-wrap gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          {items.map((item) => {
            const onHand = item.inv?.countStartOfCon ?? 0;
            const ordered = item.inv?.countOrdered ?? 0;
            return (
              <span
                key={item.id}
                className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300"
              >
                {item.name}{" "}
                <strong className="text-zinc-100">{onHand}</strong>
                {ordered > 0 && (
                  <span className="text-zinc-500"> (+{ordered} on order)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EditGrid({ items, year }: { items: ConsumableRow[]; year: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Item</th>
            {CONSUMABLE_COUNT_FIELDS.map((f) => (
              <th key={f.key} className="px-3 py-2 font-medium">
                {f.label}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Notes</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {items.map((item) => (
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
                inv={item.inv}
                fields={CONSUMABLE_COUNT_FIELDS}
                canManage={true}
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
