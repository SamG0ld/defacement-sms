"use client";

// Per-row status control on the /signs list: a deliberate two-step change so a
// stray click can't re-stage a sign. Click a status to ARM it (it highlights and
// a Confirm button appears); click Confirm to commit. Clicking the armed status
// again — or arming a different one — cancels/re-arms. The current status renders
// as a non-interactive badge.
//
// Commit goes through the DURABLE status queue (M11 #2): enqueue() writes the
// change to an IndexedDB outbox and syncs in the background, so a change made on a
// flaky floor survives connectivity drops. The displayed status reads the queue's
// optimistic overlay on top of the server-rendered status, with a queued/failed
// indicator. If no queue provider is mounted (shouldn't happen under /signs), it
// degrades to submitting the updateSignStatus Server Action form online.

import { useState } from "react";

import type { SignStatus } from "@/app/generated/prisma/client";

import { updateSignStatus } from "./actions";
import { SIGN_STATUSES, statusBadgeClass, statusLabel } from "./_lib";
import { useStatusSync } from "./_sync/provider";

export function RowStatusControl({
  signId,
  status,
}: {
  signId: number;
  status: SignStatus;
}) {
  const [armed, setArmed] = useState<SignStatus | null>(null);
  const sync = useStatusSync();

  // The overlay (queued/failed/synced) wins over the server status so an
  // optimistic change shows instantly and survives a reload.
  const entry = sync?.overlay[signId];
  const current = (entry?.status as SignStatus | undefined) ?? status;
  const indicator = entry?.indicator;

  return (
    <form
      action={updateSignStatus.bind(null, signId)}
      className="flex flex-wrap items-center gap-1"
    >
      {SIGN_STATUSES.map((s) => {
        if (s === current) {
          return (
            <span key={s} className={`badge ${statusBadgeClass(s)}`}>
              {statusLabel(s)}
              {indicator === "queued" && (
                <span className="text-amber-300" title="Queued — syncing">
                  ⟳
                </span>
              )}
              {indicator === "failed" && (
                <span className="text-danger" title="Sync failed — see the queue">
                  !
                </span>
              )}
            </span>
          );
        }
        const isArmed = armed === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => setArmed(isArmed ? null : s)}
            title={`Change status to ${s}`}
            className={
              isArmed
                ? `rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s)} is-armed`
                : "rounded border border-zinc-800 px-2 py-0.5 text-[10px] uppercase text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
            }
          >
            {statusLabel(s)}
          </button>
        );
      })}

      {armed && (
        <>
          {/* Carried for the no-provider fallback form submit. */}
          <input type="hidden" name="status" value={armed} />
          <button
            type="submit"
            onClick={(e) => {
              // With a queue provider, commit via the durable outbox and never
              // submit the form. Without one, let the Server Action form submit.
              if (sync) {
                e.preventDefault();
                const form = e.currentTarget.form;
                sync.enqueue(signId, armed).then(
                  () => setArmed(null),
                  () => {
                    // IndexedDB unavailable (private mode / quota): fall back to
                    // the online Server Action so the change isn't silently
                    // dropped on a flaky floor.
                    form?.requestSubmit();
                  },
                );
              }
            }}
            className="fade-in rounded border border-[var(--accent)] px-2 py-0.5 text-[10px] uppercase text-accent hover:opacity-80"
          >
            ✓ confirm
          </button>
        </>
      )}
    </form>
  );
}
