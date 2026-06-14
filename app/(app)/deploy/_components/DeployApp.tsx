"use client";

import { useMemo, useState } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";
import { useDevice } from "@/app/_components/DeviceProvider";
import { Skeleton } from "@/app/_components/Skeleton";
import { useDeployStore } from "../_lib/store";
import type {
  ClaimPayload,
  DeployPayload,
  ReleasePayload,
} from "../_lib/types";
import { CrewBar } from "./CrewBar";
import { DeploySheet } from "./DeploySheet";
import { FocusPane } from "./FocusPane";
import { QueuePanel } from "./QueuePanel";
import { SignList } from "./SignList";

// Top-level client app for the floor tool. Owns the store and derives the three
// sign buckets the UI renders. The layout is device-adaptive: a single-column
// field flow on mobile, a list + right-rail (sync queue + sign preview) layout on
// desktop. Everything below it is presentational.
export function DeployApp({ currentUserId }: { currentUserId: string }) {
  const store = useDeployStore(currentUserId);
  const { isMobile } = useDevice();

  // Desktop preview focus + the single deploy-confirmation target, both hoisted
  // here so the list rows AND the desktop preview pane drive ONE DeploySheet.
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeploySignView | null>(null);

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

  // Resolve the focused sign from the store each render so the preview reflects
  // live claim/deploy state, not a stale snapshot taken at click time.
  const focusedSign =
    focusedId !== null ? (store.signs[focusedId] ?? null) : null;
  const focusedCanDeploy =
    !!focusedSign &&
    focusedSign.status === "sorted" &&
    focusedSign.claimedByCrewId === store.activeCrewId;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-accent">Field Deployment</h1>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${
              store.online
                ? "bg-[var(--surface-2)] text-zinc-300"
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
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-1 text-zinc-400">
              {store.pendingCount} queued
            </span>
          )}
          <button
            type="button"
            onClick={() => void store.syncNow()}
            disabled={store.syncing || !store.online}
            className="btn btn-sm disabled:opacity-40"
          >
            {store.syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
      </header>

      {store.bootError && (
        <p className="panel px-3 py-2 text-sm text-zinc-400">
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
      {/* Mobile keeps the sync queue inline near the top; desktop moves it into
          the right rail beside the list (rendered below). */}
      {isMobile && <QueuePanel store={store} />}

      {!store.loaded ? (
        // Client-side load (IndexedDB + bootstrap sync), so this is a skeleton
        // inside the page, not a route-level loading.tsx. The sr-only status keeps
        // the AT cue the old "Loading the floor…" text gave (Next's route
        // announcer can't see this client-state load); the shimmer is aria-hidden.
        // Shapes the search bar + sign rows the list will fill in.
        <>
          <span className="sr-only" role="status" aria-live="polite">
            Loading the floor…
          </span>
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-10 w-full rounded-lg" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </>
      ) : isMobile ? (
        // onFocus is never called in the mobile layout (rows toggle selection,
        // not focus) — wired only to satisfy the shared prop contract.
        <SignList
          buckets={buckets}
          pendingSignIds={pendingSignIds}
          store={store}
          layout="mobile"
          focusedId={null}
          onFocus={setFocusedId}
          onDeploy={setDeployTarget}
        />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <SignList
            buckets={buckets}
            pendingSignIds={pendingSignIds}
            store={store}
            layout="desktop"
            focusedId={focusedId}
            onFocus={setFocusedId}
            onDeploy={setDeployTarget}
          />
          <div className="space-y-4 lg:sticky lg:top-4">
            <QueuePanel store={store} />
            <FocusPane
              sign={focusedSign}
              pending={focusedSign ? pendingSignIds.has(focusedSign.id) : false}
              canDeploy={focusedCanDeploy}
              onDeploy={setDeployTarget}
            />
          </div>
        </div>
      )}

      {deployTarget && (
        <DeploySheet
          sign={deployTarget}
          onCancel={() => setDeployTarget(null)}
          onConfirm={(opts) => {
            void store.deploy(deployTarget.id, opts);
            setDeployTarget(null);
          }}
        />
      )}
    </div>
  );
}
