"use client";

import { useMemo } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";
import { useDeployStore } from "../_lib/store";
import type {
  ClaimPayload,
  DeployPayload,
  ReleasePayload,
} from "../_lib/types";
import { CrewBar } from "./CrewBar";
import { QueuePanel } from "./QueuePanel";
import { SignList } from "./SignList";

// Top-level client app for the floor tool. Owns the store and derives the three
// sign buckets the UI renders. Everything below it is presentational.
export function DeployApp({ currentUserId }: { currentUserId: string }) {
  const store = useDeployStore(currentUserId);

  // Sign ids touched by a not-yet-synced local action — shown as "syncing".
  const pendingSignIds = useMemo(() => {
    const ids = new Set<number>();
    for (const e of store.outbox) {
      if (e.status !== "pending") continue;
      if (e.kind === "claim" || e.kind === "release") {
        for (const id of (e.payload as ClaimPayload | ReleasePayload).signIds)
          ids.add(id);
      } else {
        ids.add((e.payload as DeployPayload).signId);
      }
    }
    return ids;
  }, [store.outbox]);

  const buckets = useMemo(() => {
    const all = Object.values(store.signs);
    const claimable: DeploySignView[] = [];
    const myClaims: DeploySignView[] = [];
    const deployed: DeploySignView[] = [];
    let othersClaimedCount = 0;
    for (const s of all) {
      if (s.status === "deployed") {
        deployed.push(s);
      } else if (s.status === "sorted") {
        if (s.claimedByCrewId === null) claimable.push(s);
        else if (s.claimedByCrewId === store.activeCrewId) myClaims.push(s);
        else othersClaimedCount += 1;
      }
    }
    const byItem = (a: DeploySignView, b: DeploySignView) =>
      a.itemId.localeCompare(b.itemId, undefined, { numeric: true });
    claimable.sort(byItem);
    myClaims.sort(byItem);
    return { claimable, myClaims, deployed, othersClaimedCount };
  }, [store.signs, store.activeCrewId]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-accent">Field Deployment</h1>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${
              store.online
                ? "bg-zinc-800 text-zinc-300"
                : "bg-danger/20 text-danger"
            }`}
            aria-live="polite"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                store.online ? "bg-accent" : "bg-danger"
              }`}
            />
            {store.online ? "Online" : "Offline"}
          </span>
          {store.pendingCount > 0 && (
            <span className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">
              {store.pendingCount} queued
            </span>
          )}
          <button
            type="button"
            onClick={() => void store.syncNow()}
            disabled={store.syncing || !store.online}
            className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-300 enabled:hover:bg-zinc-800 disabled:opacity-40"
          >
            {store.syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
      </header>

      {store.bootError && (
        <p className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          {store.bootError}
        </p>
      )}

      {store.notice && (
        <div className="flex items-start justify-between gap-3 rounded border border-highlight/40 bg-highlight/10 px-3 py-2 text-sm text-highlight">
          <span>{store.notice}</span>
          <button
            type="button"
            onClick={store.clearNotice}
            className="shrink-0 text-highlight/70 hover:text-highlight"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <CrewBar store={store} />
      <QueuePanel store={store} />

      {!store.loaded ? (
        <p className="text-sm text-zinc-500">Loading the floor…</p>
      ) : (
        <SignList buckets={buckets} pendingSignIds={pendingSignIds} store={store} />
      )}
    </div>
  );
}
