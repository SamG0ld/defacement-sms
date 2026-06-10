import { DEPLOYMENT_SLOTS, SIGN_TYPES, shortZoneLabel } from "../_lib";

// Shapes kept minimal so both new/ and [id]/edit/ can pass plain query results.
type ZoneOption = {
  id: number;
  zoneCode: string;
  zoneName: string;
  building: string | null;
};
type TagOption = { id: number; name: string };

type SignDefaults = {
  itemId: string;
  signText: string;
  signType: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  requestor: string | null;
  requestorEmail: string | null;
  costPerUnit: { toString(): string } | null;
  zoneId: number | null;
  placementArea: string | null;
  exactDestination: string | null;
  deploymentPriority: number;
  deploymentSlot: string | null;
  notes: string | null;
};

const inputClass =
  "rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";
const labelClass = "flex flex-col gap-1 text-xs text-zinc-400";

export function SignForm({
  action,
  zones,
  tags,
  sign,
  selectedTagIds = [],
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  zones: ZoneOption[];
  tags: TagOption[];
  sign?: SignDefaults;
  selectedTagIds?: number[];
  submitLabel: string;
}) {
  const selected = new Set(selectedTagIds);
  return (
    <form action={action} className="space-y-6">
      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Identity
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            Item ID *
            <input
              name="itemId"
              required
              defaultValue={sign?.itemId ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Sign type *
            <input
              name="signType"
              required
              list="sign-types"
              defaultValue={sign?.signType ?? ""}
              className={inputClass}
            />
            <datalist id="sign-types">
              {SIGN_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Sign text *
            <input
              name="signText"
              required
              defaultValue={sign?.signText ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Size *
            <input
              name="size"
              required
              placeholder="e.g. 24x36"
              defaultValue={sign?.size ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Quantity
            <input
              name="quantity"
              type="number"
              min={1}
              defaultValue={sign?.quantity ?? 1}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              name="doubleSided"
              defaultChecked={sign?.doubleSided ?? false}
              className="h-4 w-4"
            />
            Double-sided
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              name="needsEasel"
              defaultChecked={sign?.needsEasel ?? false}
              className="h-4 w-4"
            />
            Needs easel
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Placement & scheduling
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            Zone
            <select
              name="zoneId"
              defaultValue={sign?.zoneId != null ? String(sign.zoneId) : ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {zones.map((z) => (
                <option key={z.id} value={String(z.id)}>
                  {shortZoneLabel(z)}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Deploy slot
            <select
              name="deploymentSlot"
              defaultValue={sign?.deploymentSlot ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {DEPLOYMENT_SLOTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Placement area
            <input
              name="placementArea"
              defaultValue={sign?.placementArea ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Exact destination
            <input
              name="exactDestination"
              defaultValue={sign?.exactDestination ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Deployment priority
            <input
              name="deploymentPriority"
              type="number"
              min={1}
              defaultValue={sign?.deploymentPriority ?? 2}
              className={inputClass}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Request & cost
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            Requestor
            <input
              name="requestor"
              defaultValue={sign?.requestor ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Requestor email
            <input
              name="requestorEmail"
              type="email"
              defaultValue={sign?.requestorEmail ?? ""}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Cost per unit
            <input
              name="costPerUnit"
              type="number"
              step="0.01"
              min={0}
              defaultValue={
                sign?.costPerUnit != null ? sign.costPerUnit.toString() : ""
              }
              className={inputClass}
            />
            <span className="text-[10px] text-zinc-600">
              Total cost = cost × quantity (computed on save).
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Tags
        </legend>
        {tags.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No tags defined. Seed reference data first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {tags.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-2 text-sm text-zinc-300"
              >
                <input
                  type="checkbox"
                  name="tags"
                  value={String(t.id)}
                  defaultChecked={selected.has(t.id)}
                  className="h-4 w-4"
                />
                {t.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Notes
        </legend>
        <textarea
          name="notes"
          rows={3}
          defaultValue={sign?.notes ?? ""}
          className={`${inputClass} w-full`}
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="btn-primary rounded px-4 py-2 text-sm font-medium"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
