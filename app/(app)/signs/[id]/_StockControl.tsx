"use client";

// QM stock check-out control. For a sign that belongs to a pile (a group of
// identical signs, size > 1) it shows how many of the group are left at the
// quartermaster desk and lets anyone Take / Return some. Copies are
// interchangeable, so a take flips N pool members — not necessarily this exact row.
// Each submit carries a fresh clientId so an at-least-once replay (double-tap,
// retry) applies exactly once server-side; the button is also disabled while in
// flight. The action returns the authoritative group counts, rendered optimistically.

import { useState, useTransition } from "react";

import { nextGroupTaken } from "@/lib/stock";
import { takeFromQm, returnToQm } from "../stock-actions";

export function StockControl({
  signId,
  total,
  taken: initialTaken,
}: {
  signId: number;
  total: number;
  taken: number;
}) {
  const [taken, setTaken] = useState(initialTaken);
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = total - taken;

  function submit(direction: "take" | "return") {
    setError(null);
    // Number() (not parseInt) so "2.5" fails the integer check instead of being
    // silently truncated to 2.
    const count = Number(qty);
    if (!Number.isInteger(count) || count < 1) {
      setError("Enter a whole number of 1 or more.");
      return;
    }
    // Optimistic guard so the user gets the precise message before the round-trip
    // (the shared clamp; the server action is still the authority).
    const check = nextGroupTaken(total, taken, direction === "take" ? count : -count);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    const action = direction === "take" ? takeFromQm : returnToQm;
    const clientId = crypto.randomUUID();
    startTransition(async () => {
      const res = await action({
        signId,
        n: count,
        clientId,
        note: note.trim() || undefined,
      });
      if (res.ok) {
        setTaken(res.taken);
        setNote("");
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-200">
        <span className="font-semibold text-accent">{remaining}</span> of {total}{" "}
        left at QM
        <span className="text-zinc-500"> · {taken} checked out</span>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          How many
          <input
            type="number"
            min={1}
            max={total}
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-20 rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Note (optional)
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="e.g. taken by Registration lead"
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </label>
        <button
          type="button"
          disabled={pending || remaining === 0}
          onClick={() => submit("take")}
          className="btn-primary rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Take
        </button>
        <button
          type="button"
          disabled={pending || taken === 0}
          onClick={() => submit("return")}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          Return
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
