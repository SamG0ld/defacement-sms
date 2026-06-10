import { upsertInventory } from "../actions";

// Shared per-row count cells for the asset + consumable tables. Lead users get
// number inputs wired (via the form={formId} attribute) to a single Save form
// rendered in the last cell; everyone else gets read-only values. Reuses the
// upsertInventory server action.

export type CountKey =
  | "countStartOfCon"
  | "countEndOfCon"
  | "countOrdered"
  | "countReceived";

export type CountField = { key: CountKey; label: string };

// Assets track the full cycle incl. end-of-con (feeds next year's on-hand).
export const ASSET_COUNT_FIELDS: CountField[] = [
  { key: "countStartOfCon", label: "On hand" },
  { key: "countOrdered", label: "Ordered" },
  { key: "countReceived", label: "Received" },
  { key: "countEndOfCon", label: "End of con" },
];

// Consumables are simpler — no end-of-con carry-forward.
export const CONSUMABLE_COUNT_FIELDS: CountField[] = [
  { key: "countStartOfCon", label: "On hand" },
  { key: "countOrdered", label: "Ordered" },
  { key: "countReceived", label: "Received" },
];

export type InvCounts = {
  countStartOfCon: number;
  countEndOfCon: number;
  countOrdered: number;
  countReceived: number;
  notes: string | null;
};

const inputClass =
  "w-20 rounded border border-zinc-700 bg-black px-2 py-1 text-sm text-zinc-100";

export function CountCells({
  typeId,
  year,
  inv,
  fields,
  canManage,
}: {
  typeId: number;
  year: number;
  inv: InvCounts | undefined;
  fields: CountField[];
  canManage: boolean;
}) {
  if (!canManage) {
    return (
      <>
        {fields.map((f) => (
          <td key={f.key} className="px-3 py-2 tabular-nums">
            {inv ? inv[f.key] : 0}
          </td>
        ))}
        <td className="px-3 py-2 text-xs text-zinc-400">{inv?.notes ?? "—"}</td>
      </>
    );
  }

  const formId = `inv-${typeId}`;
  return (
    <>
      {fields.map((f) => (
        <td key={f.key} className="px-3 py-2">
          <input
            form={formId}
            type="number"
            min={0}
            name={f.key}
            defaultValue={inv ? inv[f.key] : 0}
            className={inputClass}
          />
        </td>
      ))}
      <td className="px-3 py-2">
        <input
          form={formId}
          type="text"
          name="notes"
          defaultValue={inv?.notes ?? ""}
          className="w-48 rounded border border-zinc-700 bg-black px-2 py-1 text-sm text-zinc-100"
        />
      </td>
      <td className="px-3 py-2">
        <form id={formId} action={upsertInventory.bind(null, typeId, year)}>
          <button
            type="submit"
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Save
          </button>
        </form>
      </td>
    </>
  );
}
