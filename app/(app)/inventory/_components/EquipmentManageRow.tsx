"use client";

// The Item-cell content for a lead-editable equipment row: shows the name +
// category, with inline Edit (rename / recategorize) and a two-step Delete
// (click Delete -> Confirm), mirroring the click-then-confirm pattern used by
// the signs status control. Non-lead users never see this (the page renders a
// plain name instead). Submits through updateEquipmentType / deleteEquipmentType.

import { useState } from "react";

import { CATEGORY_OPTIONS } from "@/lib/equipment";

import { deleteEquipmentType, updateEquipmentType } from "../actions";

export function EquipmentManageRow({
  typeId,
  year,
  name,
  category,
}: {
  typeId: number;
  year: number;
  name: string;
  category: string | null;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirmDelete">("view");

  // Preserve a non-standard existing category as a selectable option so editing
  // doesn't silently reassign it.
  const options =
    category && !CATEGORY_OPTIONS.includes(category as never)
      ? [category, ...CATEGORY_OPTIONS]
      : [...CATEGORY_OPTIONS];

  if (mode === "edit") {
    return (
      <form
        action={updateEquipmentType.bind(null, typeId, year)}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          name="name"
          defaultValue={name}
          required
          className="field w-44"
        />
        <select
          name="category"
          defaultValue={category ?? "Consumable"}
          className="field"
        >
          {options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-sm">
          Save
        </button>
        <button
          type="button"
          onClick={() => setMode("view")}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>{name}</span>
      {category && <span className="text-xs text-zinc-500">{category}</span>}
      {mode === "view" ? (
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("edit")}
            className="text-xs text-zinc-600 hover:text-accent"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setMode("confirmDelete")}
            className="text-xs text-zinc-600 hover:text-[var(--danger)]"
          >
            Delete
          </button>
        </span>
      ) : (
        <form
          action={deleteEquipmentType.bind(null, typeId, year)}
          className="flex items-center gap-2"
        >
          <span className="text-xs text-[var(--danger)]">Delete?</span>
          <button type="submit" className="btn btn-danger btn-sm">
            ✓ confirm
          </button>
          <button
            type="button"
            onClick={() => setMode("view")}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
