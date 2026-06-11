"use client";

// The /signs status-change queue, made visible. On a flaky floor a volunteer
// must be able to SEE that a status change is still unsynced (never silently
// dropped) — and discard one that permanently failed. Stays out of the way when
// online with an empty queue (renders nothing).

import { useState } from "react";

import { useStatusSync } from "./provider";

export function StatusQueuePanel() {
  const sync = useStatusSync();
  const [open, setOpen] = useState(false);

  // No provider (shouldn't happen under /signs) — render nothing.
  if (!sync) return null;

  const { online, pendingCount, failedCount, authExpired, outbox, syncing } = sync;
  const hasQueue = outbox.length > 0;

  // Quiet when there's nothing to say: online, nothing queued, session fine.
  if (online && !hasQueue && !authExpired) return null;

  const failed = outbox.filter((e) => e.queueStatus === "failed");

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950 text-sm">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              online ? "bg-emerald-500" : "bg-amber-500"
            }`}
            aria-hidden
          />
          <span className="text-zinc-300">
            {online ? "Online" : "Offline"}
            {pendingCount > 0 && (
              <span className="ml-2 text-zinc-500">{pendingCount} queued</span>
            )}
            {failedCount > 0 && (
              <span className="ml-2 text-danger">{failedCount} failed</span>
            )}
          </span>
          {hasQueue && (
            <span className="text-zinc-600">{open ? "▲" : "▼"}</span>
          )}
        </button>
        {pendingCount > 0 && online && (
          <button
            type="button"
            onClick={() => void sync.syncNow()}
            disabled={syncing}
            className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      {authExpired && (
        <p className="border-t border-zinc-800 px-3 py-2 text-xs text-amber-300">
          Your session ended — reload and sign in to sync your queued changes.
        </p>
      )}

      {open && failed.length > 0 && (
        <ul className="divide-y divide-zinc-800 border-t border-zinc-800">
          {failed.map((e) => (
            <li
              key={e.clientId}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <span className="text-zinc-300">
                  Sign #{e.signId} → {e.status}
                </span>
                {e.lastError && (
                  <p className="truncate text-danger">{e.lastError}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void sync.discardFailed(e.clientId)}
                className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800"
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
