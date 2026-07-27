"use client";

import { useActionState, useState } from "react";

import {
  DEPLOYMENT_SLOTS,
  SIGN_CATEGORIES,
  SIGN_CATEGORY_LABELS,
  SIGN_TYPES,
  zoneSelectOptions,
} from "../_lib";
import { EMPTY_SIGN_FORM_STATE, type SignFormState } from "../_form-state";
import {
  SIGN_FORMATS,
  formatForKey,
  formatForSize,
} from "@/lib/sign-format";
import type { SignCategory } from "@/app/generated/prisma/enums";

// Sentinel picker value for a sign whose fields don't match any canonical format
// (a truly custom size, or a to-be-cleaned off-format size). Submits format="" so
// the server keeps the raw advanced fields instead of deriving.
const CUSTOM_FORMAT = "__custom__";
// Default format for a brand-new sign — the most common class (a foamcore easel).
const DEFAULT_FORMAT = SIGN_FORMATS[0];

// Shapes kept minimal so both new/ and [id]/edit/ can pass plain query results.
type ZoneOption = {
  id: number;
  zoneCode: string;
  zoneName: string;
  building: string | null;
  // Only the edit page supplies this — it also returns the sign's own zone when
  // that zone has been deactivated, so the option can be labelled as such.
  isActive?: boolean;
};
type TagOption = { id: number; name: string };

type SignDefaults = {
  itemId: string;
  signText: string;
  backText: string | null;
  signType: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  needsEasel: boolean;
  category: SignCategory;
  printable: boolean;
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
  action: (
    state: SignFormState,
    formData: FormData,
  ) => Promise<SignFormState>;
  zones: ZoneOption[];
  tags: TagOption[];
  sign?: SignDefaults;
  selectedTagIds?: number[];
  submitLabel: string;
}) {
  const selected = new Set(selectedTagIds);
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_SIGN_FORM_STATE,
  );

  // Format is the primary control. On edit, pre-select the format the sign's size
  // maps to (or "custom" for an off-format size); on create, default to a foamcore
  // easel. The physical fields (size/type/category/double) live in state so picking
  // a format rewrites them in one move, and editing a raw field drops back to custom.
  const matched = sign ? formatForSize(sign.size) : undefined;
  const initialFormatKey = sign
    ? (matched?.key ?? CUSTOM_FORMAT)
    : DEFAULT_FORMAT.key;
  // The format in effect at mount: the matched format on edit, the default on create,
  // or null for an off-format (Custom) edit. Seeding the format-controlled fields from
  // it — rather than the sign's raw stored values — makes the Advanced panel show
  // exactly what a save will persist, transparently correcting a drifted on-format sign
  // (e.g. size 4'x8' Single but a poster type). needsEasel is independent of the format,
  // so it seeds from the sign; only an off-format edit keeps the raw stored values.
  const initialFormat = matched ?? (sign ? null : DEFAULT_FORMAT);
  const seed = initialFormat
    ? {
        size: initialFormat.size,
        signType: initialFormat.signType,
        category: initialFormat.category,
        doubleSided: initialFormat.doubleSided,
        needsEasel: sign?.needsEasel ?? initialFormat.needsEasel,
      }
    : {
        size: sign!.size,
        signType: sign!.signType,
        category: sign!.category,
        doubleSided: sign!.doubleSided,
        needsEasel: sign!.needsEasel,
      };

  const [formatKey, setFormatKey] = useState<string>(initialFormatKey);
  const [size, setSize] = useState(seed.size);
  const [signType, setSignType] = useState(seed.signType);
  const [category, setCategory] = useState<SignCategory>(seed.category);
  const [doubleSided, setDoubleSided] = useState(seed.doubleSided);
  const [needsEasel, setNeedsEasel] = useState(seed.needsEasel);
  // Open the advanced panel up-front only when the sign is already off-format, so a
  // clean sign stays one-field but a mismatch is visible to fix.
  const [advancedOpen, setAdvancedOpen] = useState(
    initialFormatKey === CUSTOM_FORMAT,
  );

  // Pick a format: rewrite every derived field (double-sided included), and reset the
  // easel marking to the format's default (still overridable below). "Custom" leaves
  // the fields as-is for manual entry.
  function chooseFormat(key: string) {
    // Re-picking the format that's already active is a no-op, not a change. Without
    // this guard it would rewrite needsEasel back to the format default, silently
    // discarding a manual bare-easel override the user never meant to touch.
    if (key === formatKey) return;
    const f = formatForKey(key);
    if (!f) {
      // Custom: reveal the raw fields so there's an obvious place to enter them.
      setFormatKey(CUSTOM_FORMAT);
      setAdvancedOpen(true);
      return;
    }
    setFormatKey(key);
    setSize(f.size);
    setSignType(f.signType);
    setCategory(f.category);
    setDoubleSided(f.doubleSided);
    setNeedsEasel(f.needsEasel);
  }

  // Any manual edit to a format-controlled field means the sign no longer matches a
  // canonical format — drop the picker to "custom" so it never lies about the shape.
  const toCustom = () => setFormatKey(CUSTOM_FORMAT);

  return (
    <form action={formAction} className="space-y-6">
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
            Format *
            {/* The single source of truth: one choice sets size + type + category +
                double-sided (and defaults the easel marking below). Single vs Double
                are distinct entries so double-sided is never a checkbox that's missed.
                The hidden input is what the server reads; when "Custom" is selected it
                submits "" so the advanced fields are used verbatim. */}
            <select
              value={formatKey}
              onChange={(e) => chooseFormat(e.target.value)}
              className={inputClass}
            >
              {SIGN_FORMATS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
              <option value={CUSTOM_FORMAT}>Custom / advanced…</option>
            </select>
            <input
              type="hidden"
              name="format"
              value={formatKey === CUSTOM_FORMAT ? "" : formatKey}
            />
            <span className="text-[10px] text-zinc-600">
              Sets size, type, category &amp; double-sided. Override in Advanced below.
            </span>
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
          {/* Back-face text: only for a double-sided board whose two faces carry
              different words (same artwork). Shown only when double-sided; the server
              (readSignForm) drops it otherwise, so a hidden value can't persist. */}
          {doubleSided ? (
            <label className={`${labelClass} md:col-span-2`}>
              Back text
              <input
                name="backText"
                defaultValue={sign?.backText ?? ""}
                className={inputClass}
              />
              <span className="text-[10px] text-zinc-600">
                Only if the back face reads differently from the front. Leave blank
                when both sides match.
              </span>
            </label>
          ) : null}
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
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                name="needsEasel"
                checked={needsEasel}
                onChange={(e) => setNeedsEasel(e.target.checked)}
                className="h-4 w-4"
              />
              Needs easel
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                name="printable"
                defaultChecked={sign?.printable ?? true}
                className="h-4 w-4"
              />
              Printable (uncheck for bare easels — counted as easels, not prints)
            </label>
          </div>
        </div>

        {/* Advanced: the raw physical fields the Format picker drives. Editing any of
            them drops the picker to "Custom" so it never misrepresents the shape.
            Pre-opened when the sign is already off-format. */}
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          className="rounded border border-zinc-800/80 bg-black/30 px-3 py-2"
        >
          <summary className="cursor-pointer text-xs text-zinc-400">
            Advanced — override size / type / category
          </summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <label className={labelClass}>
              Sign type *
              <input
                name="signType"
                required
                list="sign-types"
                value={signType}
                onChange={(e) => {
                  setSignType(e.target.value);
                  toCustom();
                }}
                className={inputClass}
              />
              <datalist id="sign-types">
                {SIGN_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className={labelClass}>
              Size *
              <input
                name="size"
                required
                placeholder="e.g. 24x36"
                value={size}
                onChange={(e) => {
                  setSize(e.target.value);
                  toCustom();
                }}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Category *
              <select
                name="category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as SignCategory);
                  toCustom();
                }}
                className={inputClass}
              >
                {SIGN_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SIGN_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 self-end text-sm text-zinc-300">
              <input
                type="checkbox"
                name="doubleSided"
                checked={doubleSided}
                onChange={(e) => {
                  setDoubleSided(e.target.checked);
                  toCustom();
                }}
                className="h-4 w-4"
              />
              Double-sided
            </label>
          </div>
        </details>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <legend className="px-1 text-sm font-semibold text-zinc-300">
          Placement & scheduling
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            Zone
            {/* Options come from zoneSelectOptions so the list is guaranteed to
                contain the sign's current zone — a deactivated (or missing) zone
                still renders, flagged, instead of falling through to "— none —"
                and wiping the placement on the next save. */}
            <select
              name="zoneId"
              defaultValue={sign?.zoneId != null ? String(sign.zoneId) : ""}
              className={inputClass}
            >
              {zoneSelectOptions(zones, sign?.zoneId).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
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

      {state.error ? (
        <p
          role="alert"
          className="rounded border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
