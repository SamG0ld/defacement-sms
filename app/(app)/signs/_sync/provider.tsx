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
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";

import type { SignStatusValue } from "@/lib/deploy/contract";
import { createCircuitBreaker } from "@/lib/offline/circuit-breaker";
import { jitterMs } from "@/lib/offline/jitter";
import { isOnlineNow, subscribeOnline } from "@/lib/offline/online";
import { allEntries, deleteEntry } from "./idb";
import { enqueueStatus } from "./outbox";
import { reconcile } from "./overlay";
import { drainOutbox, pruneDeadLetters } from "./sync";
import type { StatusOutboxEntry, StatusOverlay } from "./types";

const SYNC_INTERVAL_MS = 20_000;

// One breaker per engine (see the deploy store). Backs off when the server is
// degraded so the status queue doesn't hammer it at full cadence. (#81)
const breaker = createCircuitBreaker();

// A fresh mount gets one immediate probe even mid-backoff, rate-limited so
// repeated navigation can't hammer a degraded server. Mirrors the deploy
// store. (#206)
const MOUNT_RESET_MIN_INTERVAL_MS = 30_000;
let lastMountReset = 0;

type StatusSync = {
  overlay: StatusOverlay;
  outbox: StatusOutboxEntry[];
  online: boolean;
  syncing: boolean;
  backingOff: boolean;
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
  // Connectivity has two independent inputs, kept separate so neither clobbers
  // the other:
  //  - the browser's own signal, read through useSyncExternalStore. The server
  //    snapshot is a constant `true`, so SSR and the hydration render always
  //    agree; React swaps in the measured value once hydration commits. Reading
  //    navigator during render instead would mismatch on a phone that is already
  //    offline at page load — StatusQueuePanel renders off this (issue #150) —
  //    and the online/offline events can't save us there, since they fire on a
  //    TRANSITION and never for the state the browser started in.
  //  - whether the server is actually reachable, which a failed drain reports
  //    even while the browser still claims to be online (captive portal, dead
  //    backhaul — routine at the venue).
  const browserOnline = useSyncExternalStore(
    subscribeOnline,
    isOnlineNow,
    () => true,
  );
  const [serverReachable, setServerReachable] = useState(true);
  const online = browserOnline && serverReachable;
  const [syncing, setSyncing] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  // True while the breaker is refusing ticks, so a backed-off queue reads as
  // "waiting" rather than "stuck". (#206)
  const [backingOff, setBackingOff] = useState(false);
  const syncingRef = useRef(false);
  const mountedRef = useRef(true);

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
    if (!breaker.canRequest()) {
      setBackingOff(true); // circuit open — say so rather than sitting silent (#81/#206)
      return;
    }
    setBackingOff(false);
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await drainOutbox();
      // Feed the breaker BEFORE the mounted-guard so a half-open probe is ALWAYS
      // resolved even if we unmounted mid-drain (else the next canRequest wedges).
      // A transient stop (network / 5xx / 429) is a failure; a clean drain — incl.
      // an auth-expiry, which is the SESSION not the server — closes it. (#81/#105)
      if (res.stoppedOffline) breaker.onFailure();
      else breaker.onSuccess();
      // Unmounted mid-drain — skip the UI updates AND the router.refresh (which
      // would navigate a tree the user already left). (#105)
      if (!mountedRef.current) return;
      setServerReachable(!res.stoppedOffline);
      if (res.authExpired) setAuthExpired(true);
      // Keep the dead-letter pile bounded WITHIN a long-lived session: a device
      // parked on /signs for a whole shift never remounts, so a mount-only prune
      // would let it grow all con. (#207)
      if (res.deadLettered > 0 || res.forbidden > 0) await pruneDeadLetters();
      await refreshOutbox();
      // Pull server truth for whatever drained (the list badge, the detail
      // timeline + stamps). The sticky "synced" overlay keeps the badge from
      // flickering to the stale RSC value in the window before this lands.
      if (res.drained > 0) router.refresh();
    } catch {
      // drainOutbox reports server errors in-band (it doesn't throw them), so
      // anything here is an unexpected client-side fault (IDB, a bug) — NOT server
      // trouble. Resolve the breaker's half-open probe WITHOUT backing off; the
      // outbox is intact and the next tick retries. (#81)
      breaker.onSuccess();
      // The drain may still have progressed before it threw (it now survives a
      // per-entry IndexedDB write failure, but allEntries itself can reject).
      // Re-derive the overlay from whatever durable state exists instead of
      // leaving rows badged "queued" for changes the server already applied until
      // the next 20s tick. Best-effort — refreshOutbox swallows its own IDB
      // errors, and this must not mask the original fault. (#245)
      if (mountedRef.current) await refreshOutbox();
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
      // Guard the IDB write: discard is fire-and-forget at the call site, so an
      // unhandled rejection here would be a swallowed promise. The entry simply
      // stays in the queue on failure; the user can retry. (#60)
      try {
        await deleteEntry(clientId);
        await refreshOutbox();
      } catch {
        /* IDB failure — the failed entry stays; the next discard/tick retries */
      }
    },
    [refreshOutbox],
  );

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  // Track mount so a drain that resolves AFTER unmount skips its UI updates and
  // the router.refresh (the durable outbox / breaker are settled regardless). (#105)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Returning to /signs is a deliberate "sync now" gesture; give this mount
      // one probe even if an earlier backoff window is still running. (#206)
      const now = Date.now();
      if (now - lastMountReset >= MOUNT_RESET_MIN_INTERVAL_MS) {
        lastMountReset = now;
        breaker.probeOnce();
        setBackingOff(false);
      }
      // Trim the dead-letter pile before reading it, so a long-lived shared
      // device doesn't carry an unbounded queue into every tick. (#207)
      await pruneDeadLetters();
      if (cancelled) return;
      await refreshOutbox(); // rebuild overlay from durable state on mount
      if (!cancelled) await syncNow();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshOutbox, syncNow]);

  useEffect(() => {
    let onlineTimer: number | undefined;
    // The badge itself now follows `browserOnline`; this listener exists to give
    // the server-reachability flag the benefit of the doubt on reconnect and to
    // kick a sync. (There's no matching "offline" handler any more — the external
    // store already reports that.)
    const goOnline = () => {
      setServerReachable(true);
      // Jitter the reconnect sync so a venue-wide blip doesn't make every device
      // hammer the pg pool in a synchronized burst. (#80)
      onlineTimer = window.setTimeout(() => void syncNow(), jitterMs());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    window.addEventListener("online", goOnline);
    document.addEventListener("visibilitychange", onVisible);
    // Stagger the interval's START (0–20s) so co-loaded devices don't align. (#80)
    let timer: ReturnType<typeof setInterval> | undefined;
    const startDelay = window.setTimeout(() => {
      timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
    }, jitterMs(SYNC_INTERVAL_MS));
    return () => {
      window.removeEventListener("online", goOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(onlineTimer);
      window.clearTimeout(startDelay);
      if (timer) clearInterval(timer);
    };
  }, [syncNow]);

  const pendingCount = outbox.filter((e) => e.queueStatus === "pending").length;
  const failedCount = outbox.filter((e) => e.queueStatus === "failed").length;

  const value: StatusSync = {
    overlay,
    outbox,
    online,
    syncing,
    backingOff,
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
