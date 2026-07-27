"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  executeSpecialtyBatch,
  previewSpecialtyBatch,
  type SpecialtyRowInput,
  type SpecialtyPreview,
  type SpecialtyResult,
} from "../actions";
import { SPECIALTY_TYPES, specialtyType } from "../_taxonomy";
import { MAX_SPECIALTY_ROWS } from "../_limits";
import { DEPLOYMENT_SLOTS } from "../../_lib";

const labelClass = "flex flex-col gap-1 text-xs text-zinc-400";
const inputClass =
  "rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";

type ZoneOption = {
  id: number;
  zoneCode: string;
  zoneName: string;
  building: string | null;
};

type EditRow = {
  id: string;
  typeKey: string;
  itemId: string;
  signText: string;
  size: string;
  quantity: number;
  doubleSided: boolean;
  zoneId: number | null;
  placementArea: string;
  deploymentSlot: string;
  notes: string;
};

function formatZoneLabel(zone: ZoneOption): string {
  return `${zone.zoneCode} — ${zone.zoneName}`;
}

function generateEXTId(nextNumber: number, offset: number): string {
  return `EXT-${String(nextNumber + offset).padStart(3, "0")}`;
}

// Next auto ID = one past the highest EXT-number visible in the current rows
// (or the server-provided floor). Length-based offsets would re-issue a number
// after a mid-list remove; scanning the rows can't collide.
function nextExtId(rows: EditRow[], nextNumber: number): string {
  let max = nextNumber - 1;
  for (const r of rows) {
    const m = /^EXT-(\d+)$/.exec(r.itemId.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `EXT-${String(max + 1).padStart(3, "0")}`;
}

function makeEmptyRow(nextNumber: number, offset: number): EditRow {
  const type = specialtyType("floor-graphic")!;
  return {
    id: crypto.randomUUID(),
    typeKey: "floor-graphic",
    itemId: generateEXTId(nextNumber, offset),
    signText: "",
    size: type.defaultSize ?? "",
    quantity: 1,
    doubleSided: false,
    zoneId: null,
    placementArea: "",
    deploymentSlot: "",
    notes: "",
  };
}

export function SpecialtyIntake({
  zones,
  nextNumber,
}: {
  zones: ZoneOption[];
  nextNumber: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"edit" | "review" | "done">("edit");
  const [rows, setRows] = useState<EditRow[]>([makeEmptyRow(nextNumber, 0)]);
  const [preview, setPreview] = useState<SpecialtyPreview | null>(null);
  const [result, setResult] = useState<SpecialtyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function updateRow(id: string, updates: Partial<EditRow>) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const updated = { ...r, ...updates };
        // On an explicit type change, adopt the new type's default size. Picking
        // a type is a request for that type's default, so we always replace Size
        // (no stale prefill from the previous type left behind for the user to
        // type after). A blank default clears the field back to placeholder.
        if (updates.typeKey && updates.typeKey !== r.typeKey) {
          const newType = specialtyType(updates.typeKey);
          if (newType) updated.size = newType.defaultSize ?? "";
        }
        return updated;
      })
    );
  }

  function duplicateRow(id: string) {
    if (rows.length >= MAX_SPECIALTY_ROWS) return;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const duplicate = {
      ...row,
      id: crypto.randomUUID(),
      itemId: nextExtId(rows, nextNumber),
    };
    setRows((rs) => [...rs, duplicate]);
  }

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  function onReview() {
    const input: SpecialtyRowInput[] = rows.map((r) => ({
      typeKey: r.typeKey,
      itemId: r.itemId,
      signText: r.signText,
      size: r.size,
      quantity: r.quantity,
      doubleSided: r.doubleSided,
      zoneId: r.zoneId,
      placementArea: r.placementArea || null,
      deploymentSlot: r.deploymentSlot || null,
      notes: r.notes || null,
    }));

    startTransition(async () => {
      try {
        setError(null);
        const p = await previewSpecialtyBatch(input);
        if (p.error) {
          setError(p.error);
        } else {
          setPreview(p);
          setPhase("review");
        }
      } catch {
        setError("Could not preview. Make sure you are signed in as a lead.");
      }
    });
  }

  function onConfirm() {
    if (!preview) return;
    const input: SpecialtyRowInput[] = rows.map((r) => ({
      typeKey: r.typeKey,
      itemId: r.itemId,
      signText: r.signText,
      size: r.size,
      quantity: r.quantity,
      doubleSided: r.doubleSided,
      zoneId: r.zoneId,
      placementArea: r.placementArea || null,
      deploymentSlot: r.deploymentSlot || null,
      notes: r.notes || null,
    }));

    startTransition(async () => {
      try {
        const res = await executeSpecialtyBatch(input);
        setResult(res);
        setPhase("done");
        router.refresh();
      } catch {
        setError("Could not create items. Please try again.");
      }
    });
  }

  function onReset() {
    setRows([{ ...makeEmptyRow(nextNumber, 0), itemId: nextExtId(rows, nextNumber) }]);
    setPhase("edit");
    setPreview(null);
    setResult(null);
    setError(null);
  }

  if (phase === "done" && result) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-emerald-900 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          <p>
            Created <strong>{result.created}</strong> item
            {result.created === 1 ? "" : "s"}.
            {result.skipped > 0 && ` Skipped ${result.skipped}.`}
            {result.failed > 0 && ` ${result.failed} failed.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/signs"
            className="btn-primary rounded px-4 py-2 text-sm font-medium"
          >
            View signs →
          </Link>
          <button
            type="button"
            onClick={onReset}
            className="rounded border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-900"
          >
            Enter another batch
          </button>
        </div>
      </div>
    );
  }

  if (phase === "review" && preview) {
    return (
      <ReviewPanel
        preview={preview}
        zones={zones}
        pending={pending}
        onBack={() => setPhase("edit")}
        onConfirm={onConfirm}
        error={error}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <RowCard
            key={row.id}
            row={row}
            zones={zones}
            atMax={rows.length >= MAX_SPECIALTY_ROWS}
            onUpdate={(updates) => updateRow(row.id, updates)}
            onDuplicate={() => duplicateRow(row.id)}
            onRemove={() => removeRow(row.id)}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3 border-t border-zinc-800 pt-4">
        <button
          type="button"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              { ...makeEmptyRow(nextNumber, 0), itemId: nextExtId(rs, nextNumber) },
            ])
          }
          disabled={rows.length >= MAX_SPECIALTY_ROWS}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
        >
          + Add row
        </button>
        {rows.length >= MAX_SPECIALTY_ROWS && (
          <span className="text-xs text-zinc-500">max {MAX_SPECIALTY_ROWS} rows</span>
        )}
        <button
          type="button"
          onClick={onReview}
          disabled={pending || rows.length === 0}
          className="btn-primary rounded px-4 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {pending ? "Reviewing…" : `Review ${rows.length} item${rows.length === 1 ? "" : "s"} →`}
        </button>
      </div>
    </div>
  );
}

function RowCard({
  row,
  zones,
  atMax,
  onUpdate,
  onDuplicate,
  onRemove,
}: {
  row: EditRow;
  zones: ZoneOption[];
  atMax: boolean;
  onUpdate: (updates: Partial<EditRow>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const type = specialtyType(row.typeKey);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-4 md:space-y-0">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <label className={labelClass}>
          Type *
          <select
            value={row.typeKey}
            onChange={(e) => onUpdate({ typeKey: e.target.value })}
            className={inputClass}
          >
            {SPECIALTY_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Item ID *
          <input
            type="text"
            required
            value={row.itemId}
            onChange={(e) => onUpdate({ itemId: e.target.value })}
            className={inputClass}
          />
        </label>

        <label className={labelClass}>
          Name/text *
          <input
            type="text"
            required
            value={row.signText}
            onChange={(e) => onUpdate({ signText: e.target.value })}
            className={inputClass}
          />
        </label>

        <label className={labelClass}>
          Size *
          <input
            type="text"
            required
            placeholder={type?.defaultSize ? `e.g. ${type.defaultSize}` : "e.g. 24x36"}
            value={row.size}
            onChange={(e) => onUpdate({ size: e.target.value })}
            className={inputClass}
          />
        </label>

        <label className={labelClass}>
          Qty
          <input
            type="number"
            min={1}
            value={row.quantity}
            onChange={(e) =>
              onUpdate({ quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })
            }
            className={inputClass}
          />
        </label>

        <label className="flex items-center gap-2 pt-5 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={row.doubleSided}
            onChange={(e) => onUpdate({ doubleSided: e.target.checked })}
            className="h-4 w-4"
          />
          Double-sided
        </label>

        <label className={labelClass}>
          Zone
          <select
            value={row.zoneId || ""}
            onChange={(e) =>
              onUpdate({ zoneId: e.target.value ? parseInt(e.target.value, 10) : null })
            }
            className={inputClass}
          >
            <option value="">— none —</option>
            {zones.map((z) => (
              <option key={z.id} value={String(z.id)}>
                {formatZoneLabel(z)}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Placement
          <input
            type="text"
            value={row.placementArea}
            onChange={(e) => onUpdate({ placementArea: e.target.value })}
            className={inputClass}
          />
        </label>

        <label className={labelClass}>
          Install slot
          <select
            value={row.deploymentSlot}
            onChange={(e) => onUpdate({ deploymentSlot: e.target.value })}
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

        <label className={`${labelClass} md:col-span-2 lg:col-span-3`}>
          Notes
          <input
            type="text"
            value={row.notes}
            onChange={(e) => onUpdate({ notes: e.target.value })}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
        <button
          type="button"
          onClick={onDuplicate}
          disabled={atMax}
          className="text-xs rounded border border-zinc-700 bg-black px-2 py-1 text-zinc-400 hover:text-zinc-300 disabled:opacity-40"
        >
          Duplicate
        </button>
        {atMax && (
          <span className="text-xs text-zinc-500">max {MAX_SPECIALTY_ROWS} rows</span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="text-xs rounded border border-red-900 bg-red-950 px-2 py-1 text-red-300 hover:text-red-200"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function ReviewPanel({
  preview,
  zones,
  pending,
  onBack,
  onConfirm,
  error,
}: {
  preview: SpecialtyPreview;
  zones: ZoneOption[];
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
  error: string | null;
}) {
  const { counts } = preview;
  const zoneCodeById = new Map(zones.map((z) => [z.id, z.zoneCode]));
  const slotLabel = new Map(DEPLOYMENT_SLOTS.map((s) => [s.value, s.label]));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Stat
          label="Ready"
          value={counts.valid}
          tone="text-emerald-300"
        />
        <Stat
          label="Duplicates"
          value={counts.duplicate}
          tone="text-yellow-300"
        />
        <Stat label="Invalid" value={counts.invalid} tone="text-red-300" />
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Item ID</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Zone</th>
              <th className="px-3 py-2 font-medium">Slot</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {preview.rows.map((r) => {
              const statusBadgeClass = statusBadge(r.status);
              return (
                <tr key={r.index} className="align-top text-zinc-200">
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                    {r.input.itemId}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {r.input.signText}
                    {(r.input.placementArea || r.input.notes) && (
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {[r.input.placementArea, r.input.notes]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{specialtyType(r.input.typeKey)?.label}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{r.category}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{r.input.size}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{r.input.quantity}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {r.input.zoneId != null ? zoneCodeById.get(r.input.zoneId) ?? "?" : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {r.input.deploymentSlot ? slotLabel.get(r.input.deploymentSlot) ?? r.input.deploymentSlot : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-[10px] uppercase font-medium ${statusBadgeClass}`}
                    >
                      {r.status}
                    </span>
                    {r.error && (
                      <div className="mt-1 text-xs text-red-300">{r.error}</div>
                    )}
                    {r.warning && (
                      <div className="mt-1 text-xs text-yellow-300">{r.warning}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3 border-t border-zinc-800 pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className="rounded border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
        >
          ← Back to edit
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending || counts.valid === 0}
          className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {pending
            ? "Creating…"
            : `Create ${counts.valid} item${counts.valid === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

function statusBadge(status: string): string {
  switch (status) {
    case "valid":
      return "border-emerald-800 bg-emerald-950 text-emerald-300";
    case "duplicate":
      return "border-yellow-800 bg-yellow-950 text-yellow-300";
    case "invalid":
      return "border-red-900 bg-red-950 text-red-300";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-300";
  }
}
