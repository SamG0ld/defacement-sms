"use client";

// Detail-page status changer. Collects a target status + optional note and
// commits through the durable status queue (M11 #2) so a change made on a flaky
// floor survives connectivity drops. Reads the queue's optimistic overlay so the
// "current" status (and the selectable options) reflect a not-yet-synced change,
// with a queued/failed indicator. Degrades to the updateSignStatus Server Action
// form when no queue provider is mounted (shouldn't happen under /signs).

import { useRef, useState } from "react";

import type { SignStatus } from "@/app/generated/prisma/client";
import type { SignStatusValue } from "@/lib/deploy/contract";

import { updateSignStatus } from "../actions";
import { SIGN_STATUSES, statusBadgeClass } from "../_lib";
import { useStatusSync } from "../_sync/provider";

export function StatusForm({
  signId,
  status,
}: {
  signId: number;
  status: SignStatus;
}) {
  const sync = useStatusSync();
  const [choice, setChoice] = useState<SignStatus | "">("");
  const [notes, setNotes] = useState("");
  // Set when an IndexedDB-failure fallback re-submits the form so the next
  // onSubmit lets the online Server Action through instead of re-queuing.
  const fallbackSubmit = useRef(false);

  const entry = sync?.overlay[signId];
  const current = (entry?.status as SignStatus | undefined) ?? status;
  const indicator = entry?.indicator;
  const next = SIGN_STATUSES.filter((s) => s !== current);

  if (next.length === 0) {
    return <p className="text-xs text-zinc-500">No further transitions.</p>;
  }

  return (
    <div className="space-y-2">
      {indicator && (
        <p className="flex items-center gap-2 text-xs">
          <span
            className={`rounded border px-2 py-0.5 uppercase ${statusBadgeClass(current)}`}
          >
            {current}
          </span>
          {indicator === "queued" && (
            <span className="text-amber-300">queued — syncing…</span>
          )}
          {indicator === "failed" && (
            <span className="text-danger">sync failed — see the queue above</span>
          )}
          {indicator === "synced" && (
            <span className="text-emerald-400">synced</span>
          )}
        </p>
      )}

      <form
        action={updateSignStatus.bind(null, signId)}
        onSubmit={(e) => {
          // A fallback re-submit (IndexedDB failed) — let the online Server
          // Action through this time instead of re-queuing into a dead outbox.
          if (fallbackSubmit.current) {
            fallbackSubmit.current = false;
            return;
          }
          // With a queue provider, commit via the durable outbox instead of the
          // Server Action. Without one, let the form submit online.
          if (sync && choice) {
            e.preventDefault();
            const form = e.currentTarget;
            // choice is picked from the SIGN_STATUSES options (lifecycle only,
            // never `archived`), so it's always a syncable status value.
            sync.enqueue(signId, choice as SignStatusValue, notes).then(
              () => {
                setChoice("");
                setNotes("");
              },
              () => {
                // IndexedDB unavailable (private mode / quota): fall back to the
                // online Server Action so the change isn't silently dropped.
                fallbackSubmit.current = true;
                form.requestSubmit();
              },
            );
          }
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          New status
          <select
            name="status"
            required
            value={choice}
            onChange={(e) => setChoice(e.target.value as SignStatus)}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="" disabled>
              choose…
            </option>
            {next.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Note (optional)
          <input
            type="text"
            name="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            placeholder="e.g. handed off to deploy team"
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </label>
        <button
          type="submit"
          className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
        >
          Update
        </button>
      </form>
    </div>
  );
}
