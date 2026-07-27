"use client";

import { useState } from "react";

import { MapPinPicker } from "./MapPinPicker";

type FloorOption = {
  key: string;
  src: string;
  label: string;
  width?: number | null;
};

// Floor reassignment for a sign's override pin: pick which floor map to place on
// (defaults to the sign's resolved/zone floor), then drop the pin on it. This is
// the fix for "wrong map assigned" — the placement is no longer locked to the
// sign's zone. Switching floors remounts the picker (key={fm.key}) so its pin
// state resets; the prior position only carries over on the original floor,
// since a percentage means a different spot on a different map.
export function FloorReassign({
  floors,
  initialFloorKey,
  initialPos,
  current,
  action,
}: {
  floors: FloorOption[];
  initialFloorKey: string | null;
  initialPos: { x: number; y: number } | null;
  // The sign's current resolved location (room or override) + the floor it's on,
  // shown as a read-only marker so this one map also conveys where it is now.
  current?: { floorKey: string; x: number; y: number } | null;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [floorKey, setFloorKey] = useState(initialFloorKey ?? floors[0]?.key ?? "");
  const fm = floors.find((f) => f.key === floorKey) ?? floors[0];
  if (!fm) return null;

  const initial = fm.key === initialFloorKey ? initialPos : null;
  const currentMarker =
    current && current.floorKey === fm.key ? { x: current.x, y: current.y } : null;

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Floor map
        <select
          value={floorKey}
          onChange={(e) => setFloorKey(e.target.value)}
          className="field w-fit font-normal normal-case tracking-normal"
        >
          {floors.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <MapPinPicker
        key={fm.key}
        src={fm.src}
        label={fm.label}
        imageWidth={fm.width}
        initial={initial}
        currentMarker={currentMarker}
        action={action}
        hiddenFields={{ mode: "override", floor: fm.key }}
        saveLabel="Save pin"
      />
    </div>
  );
}
