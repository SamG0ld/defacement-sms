"use client";

// Compact Take N / Return N control for a QM pile (a group of identical signs).
// Copies are interchangeable, so it acts on N pool members via a representative id;
// the parent owns the displayed `taken` count and gets the authoritative value back
// through onTaken so Out / Remaining stay in sync. Each submit carries a fresh
// clientId so an at-least-once replay applies exactly once server-side. Shared by
// the /signs group header and the inventory QM rollup row.

import { useState, useTransition } from "react";

import { nextGroupTaken } from "@/lib/stock";
import { takeFromQm, returnToQm } from "../stock-actions";

export function QmTakeReturn({
  repId,
  total,
  taken,
  onTaken,
  label,
}: {
  repId: number;
  total: number;
  taken: number;
  onTaken: (taken: number) => void;
  label?: string;
}) {
  const [qty, setQty] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = total - taken;

  function submit(direction: "take" | "return") {
    setError(null);
    const count = Number(qty);
    if (!Number.isInteger(count) || count < 1) {
      setError("Whole number ≥ 1.");
      return;
    }
    // Shared clamp (same as the detail-page control) so the bound + error text
    // can't drift; the server action is still the authority.
    const check = nextGroupTaken(total, taken, direction === "take" ? count : -count);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    const action = direction === "take" ? takeFromQm : returnToQm;
    const clientId = crypto.randomUUID();
    startTransition(async () => {
      const res = await action({ signId: repId, n: count, clientId });
      if (res.ok) onTaken(res.taken);
      else setError(res.error);
    });
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <input
        type="number"
        min={1}
        max={total}
        inputMode="numeric"
        aria-label={label ?? "How many to take or return"}
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        className="w-14 rounded border border-zinc-700 bg-black px-1.5 py-1 text-right text-xs text-zinc-100"
      />
      <button
        type="button"
        disabled={pending || remaining === 0}
        onClick={() => submit("take")}
        className="btn-primary rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
      >
        Take
      </button>
      <button
        type="button"
        disabled={pending || taken === 0}
        onClick={() => submit("return")}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        Return
      </button>
      {error && <span className="ml-1 text-[10px] text-danger">{error}</span>}
    </div>
  );
}
