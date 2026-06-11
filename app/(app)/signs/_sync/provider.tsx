"use client";

// Durable status-change queue for /signs, mounted once in the signs layout so
// the list AND detail share one outbox + sync loop. Every status change is
// optimistic: it lands in the IndexedDB outbox immediately (surviving reloads
// and connectivity drops), then a foreground sync drains it. Works through a
// flaky floor — a change just queues and syncs on reconnect.
//
// This is a focused copy of the deploy tool's store, scoped to ONE mutation
// (a status change) and with no delta-pull: /signs is server-rendered, so after
// a successful drain we router.refresh() to reconcile server truth rather than
// maintaining a client-side sign cache.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import type { SignStatusValue } from "@/lib/deploy/contract";
import { allEntries, deleteEntry } from "./idb";
import { enqueueStatus } from "./outbox";
import { reconcile } from "./overlay";
import { drainOutbox } from "./sync";
import type { StatusOutboxEntry, StatusOverlay } from "./types";

const SYNC_INTERVAL_MS = 20_000;

type StatusSync = {
  overlay: StatusOverlay;
  outbox: StatusOutboxEntry[];
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  authExpired: boolean;
  enqueue: (
    signId: number,
    status: SignStatusValue,
    notes?: string | null,
  ) => Promise<void>;
  discardFailed: (clientId: string) => Promise<void>;
  syncNow: () => Promise<void>;
};

const StatusSyncContext = createContext<StatusSync | null>(null);

// Read the queue from any client component under /signs. Returns null when no
// provider is mounted (e.g. a unit-test render), so callers can fall back to the
// plain server status.
export function useStatusSync(): StatusSync | null {
  return useContext(StatusSyncContext);
}

export function SignStatusSyncProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [overlay, setOverlay] = useState<StatusOverlay>({});
  const [outbox, setOutbox] = useState<StatusOutboxEntry[]>([]);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [syncing, setSyncing] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const syncingRef = useRef(false);

  const refreshOutbox = useCallback(async () => {
    try {
      const entries = await allEntries();
      setOutbox(entries);
      setOverlay((prev) => reconcile(prev, entries));
    } catch {
      /* IndexedDB unavailable — durability degrades, the page still works online */
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await drainOutbox();
      setOnline(!res.stoppedOffline);
      if (res.authExpired) setAuthExpired(true);
      await refreshOutbox();
      // Pull server truth for whatever drained (the list badge, the detail
      // timeline + stamps). The sticky "synced" overlay keeps the badge from
      // flickering to the stale RSC value in the window before this lands.
      if (res.drained > 0) router.refresh();
    } catch {
      /* a drain-time failure leaves the outbox intact; the next tick retries */
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [refreshOutbox, router]);

  const enqueue = useCallback(
    async (
      signId: number,
      status: SignStatusValue,
      notes?: string | null,
    ) => {
      // Durable FIRST: persist to the outbox before touching the overlay. If the
      // IndexedDB write throws, refreshOutbox below rebuilds the overlay from the
      // (unchanged) durable state, so a failed write never leaves a phantom
      // "queued"/"synced" badge for a change that was never stored.
      await enqueueStatus(signId, status, notes);
      setOverlay((prev) => ({ ...prev, [signId]: { status, indicator: "queued" } }));
      await refreshOutbox();
      void syncNow();
    },
    [refreshOutbox, syncNow],
  );

  const discardFailed = useCallback(
    async (clientId: string) => {
      await deleteEntry(clientId);
      await refreshOutbox();
    },
    [refreshOutbox],
  );

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshOutbox(); // rebuild overlay from durable state on mount
      if (!cancelled) await syncNow();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshOutbox, syncNow]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const goOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [syncNow]);

  const pendingCount = outbox.filter((e) => e.queueStatus === "pending").length;
  const failedCount = outbox.filter((e) => e.queueStatus === "failed").length;

  const value: StatusSync = {
    overlay,
    outbox,
    online,
    syncing,
    pendingCount,
    failedCount,
    authExpired,
    enqueue,
    discardFailed,
    syncNow,
  };

  return (
    <StatusSyncContext.Provider value={value}>
      {children}
    </StatusSyncContext.Provider>
  );
}
