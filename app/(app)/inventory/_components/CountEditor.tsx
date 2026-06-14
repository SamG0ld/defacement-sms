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

const inputClass = "field w-20";

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
          <td key={f.key} className="t-mono tabular-nums">
            {inv ? inv[f.key] : 0}
          </td>
        ))}
        <td className="t-dim">{inv?.notes ?? "—"}</td>
      </>
    );
  }

  const formId = `inv-${typeId}`;
  return (
    <>
      {fields.map((f) => (
        <td key={f.key}>
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
      <td>
        <input
          form={formId}
          type="text"
          name="notes"
          defaultValue={inv?.notes ?? ""}
          className="field w-48"
        />
      </td>
      <td>
        <form id={formId} action={upsertInventory.bind(null, typeId, year)}>
          <button type="submit" className="btn btn-sm">
            Save
          </button>
        </form>
      </td>
    </>
  );
}
