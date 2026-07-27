"use client";

import { useState } from "react";

import type { DeployStore } from "../_lib/store";
import type { OutboxEntry } from "../_lib/types";

function describe(entry: OutboxEntry): string {
  switch (entry.kind) {
    case "claim": {
      const p = entry.payload as { signIds: number[] };
      return `Claim ${p.signIds.length} sign(s)`;
    }
    case "release": {
      const p = entry.payload as { signIds: number[] };
      return `Release ${p.signIds.length} sign(s)`;
    }
    case "deploy": {
      const p = entry.payload as { signId: number };
      return `Deploy sign #${p.signId}`;
    }
    case "photo": {
      const p = entry.payload as { signId: number };
      return `Photo for sign #${p.signId}`;
    }
    default: {
      // Exhaustiveness guard (#237). A new OutboxKind added without a case here
      // used to fall through and return undefined, which React renders as a blank
      // line — a crew would see an entry in the queue with no idea what it was, on
      // the one screen they rely on to know what hasn't synced. The `never`
      // assignment makes that a BUILD failure instead. It narrows on `entry.kind`,
      // not `entry`: OutboxEntry isn't a discriminated union, its payload is a
      // plain union.
      //
      // Deliberately returns rather than throws. `describe()` runs during render
      // inside the outbox .map(), and the nearest boundary is the root
      // app/error.tsx — so a throw here would replace the ENTIRE field tool with an
      // error card, and re-expanding the queue would just crash it again. The
      // outbox is durable across sessions AND across deploys, so a device holding
      // an entry written by a different build is a real mid-con scenario, not a
      // hypothetical. A labelled, still-discardable row is the safe failure.
      const unhandled: never = entry.kind;
      return `Queued action (${String(unhandled)})`;
    }
  }
}

// The outbox, made visible. Crews on a dead RF floor must be able to SEE they
// have unsynced work (never silently dropped) — pending entries here, and a
// dead-letter list of permanently-failed actions they can discard.
export function QueuePanel({ store }: { store: DeployStore }) {
  const [open, setOpen] = useState(false);

  if (store.outbox.length === 0) return null;

  const pending = store.outbox.filter((e) => e.status === "pending");
  const failed = store.outbox.filter((e) => e.status === "failed");

  return (
    <section className="panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm"
      >
        <span className="text-zinc-300">
          Sync queue
          {pending.length > 0 && (
            <span className="ml-2 text-zinc-500">{pending.length} pending</span>
          )}
          {failed.length > 0 && (
            <span className="ml-2 text-danger">{failed.length} failed</span>
          )}
        </span>
        <span className="text-zinc-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
          {store.outbox.map((e) => (
            <li
              key={e.clientId}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <span className="text-zinc-300">{describe(e)}</span>
                {e.status === "failed" && (
                  <p className="truncate text-danger">{e.lastError}</p>
                )}
              </div>
              {e.status === "failed" ? (
                <button
                  type="button"
                  onClick={() => void store.discardFailed(e)}
                  className="btn btn-sm shrink-0"
                >
                  Discard
                </button>
              ) : (
                <span className="shrink-0 text-zinc-600">pending</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
