"use client";

// The floor tool's client state machine. Holds server truth (crews + the
// working sign set + the delta cursor) and the live outbox, and exposes the
// actions the UI calls. Every mutation is optimistic: it lands in the durable
// IndexedDB outbox immediately, then a foreground sync pushes it and pulls the
// reconciled truth back. Works fully offline — actions just queue.

import { useCallback, useEffect, useRef, useState } from "react";

import type { CrewView, DeploySignView } from "@/lib/deploy/contract";
import * as api from "./api";
import { NetworkError } from "./api";
import { allEntries, deleteEntry, deletePhoto } from "./idb";
import { enqueueClaim, enqueueDeploy, enqueueRelease } from "./outbox";
import { syncOnce } from "./sync";
import type { OutboxEntry } from "./types";

const ACTIVE_CREW_KEY = "deploy.activeCrewId";
const SYNC_INTERVAL_MS = 20_000;

export type DeployStore = ReturnType<typeof useDeployStore>;

function readActiveCrew(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ACTIVE_CREW_KEY);
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) ? n : null;
}

export function useDeployStore(currentUserId: string) {
  const [loaded, setLoaded] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // Lazy initializers (not effect setState): read the external systems once at
  // first client render. Safe for hydration — crews is empty at first paint, so
  // neither value affects the initial DOM. SSR sees online=true / no active crew.
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [syncing, setSyncing] = useState(false);
  const [crews, setCrews] = useState<CrewView[]>([]);
  const [myCrewIds, setMyCrewIds] = useState<number[]>([]);
  const [activeCrewId, setActiveCrewIdState] = useState<number | null>(() =>
    readActiveCrew(),
  );
  const [signs, setSigns] = useState<Record<number, DeploySignView>>({});
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const cursorRef = useRef<string>("");
  const syncingRef = useRef(false);

  const refreshOutbox = useCallback(async () => {
    try {
      setOutbox(await allEntries());
    } catch {
      /* IndexedDB unavailable — queue features degrade, app still works online */
    }
  }, []);

  const mergeSigns = useCallback((incoming: DeploySignView[]) => {
    if (incoming.length === 0) return;
    setSigns((prev) => {
      const next = { ...prev };
      for (const s of incoming) next[s.id] = s;
      return next;
    });
  }, []);

  const bootstrapNow = useCallback(async () => {
    const data = await api.getBootstrap();
    setCrews(data.crews);
    setMyCrewIds(data.myCrewIds);
    setSigns(Object.fromEntries(data.signs.map((s) => [s.id, s])));
    cursorRef.current = data.cursor;
    setLoaded(true);
    setBootError(null);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await syncOnce(cursorRef.current);
      mergeSigns(res.changedSigns);
      cursorRef.current = res.cursor;
      setOnline(!res.stoppedOffline);

      // Reconcile rejected claims explicitly. The delta pull only carries signs
      // whose updatedAt advanced past our cursor, so a sign another crew claimed
      // BEFORE our cursor won't be in `changedSigns` — without this, our
      // optimistic "claimed by my crew" overlay would stay stuck. byCrewId is the
      // crew that actually holds it (null for not_sorted/not_found).
      if (res.claimRejections.length > 0) {
        setSigns((prev) => {
          const next = { ...prev };
          for (const rej of res.claimRejections) {
            const s = next[rej.signId];
            if (!s) continue;
            next[rej.signId] = {
              ...s,
              claimedByCrewId: rej.byCrewId,
              claimedByUserId: rej.byCrewId === null ? null : s.claimedByUserId,
            };
          }
          return next;
        });
      }

      const msgs: string[] = [];
      if (res.authExpired) {
        msgs.push(
          "Your session ended — reload and sign in to sync your queued work.",
        );
      }
      if (res.claimRejections.length > 0) {
        msgs.push(
          `${res.claimRejections.length} sign(s) couldn't be claimed (already taken or not ready).`,
        );
      }
      if (res.deployConflicts.length > 0) {
        msgs.push(
          `${res.deployConflicts.length} sign(s) were already deployed by another crew.`,
        );
      }
      if (res.deadLettered > 0) {
        msgs.push(`${res.deadLettered} queued action(s) failed — see the queue.`);
      }
      setNotice(msgs.length > 0 ? msgs.join(" ") : null);
      await refreshOutbox();
    } catch (err) {
      if (err instanceof NetworkError) setOnline(false);
      // changes-pull failure is non-fatal; the outbox is intact and we retry.
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [mergeSigns, refreshOutbox]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const setActiveCrew = useCallback((id: number | null) => {
    setActiveCrewIdState(id);
    if (typeof localStorage !== "undefined") {
      if (id === null) localStorage.removeItem(ACTIVE_CREW_KEY);
      else localStorage.setItem(ACTIVE_CREW_KEY, String(id));
    }
  }, []);

  const claim = useCallback(
    async (signIds: number[]) => {
      if (activeCrewId === null || signIds.length === 0) return;
      // Optimistic: show the signs as claimed by my crew immediately.
      setSigns((prev) => {
        const next = { ...prev };
        for (const id of signIds) {
          const s = next[id];
          if (s && s.claimedByCrewId === null && s.status === "sorted") {
            next[id] = {
              ...s,
              claimedByCrewId: activeCrewId,
              claimedByUserId: currentUserId,
            };
          }
        }
        return next;
      });
      await enqueueClaim(activeCrewId, signIds);
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, currentUserId, refreshOutbox, syncNow],
  );

  const release = useCallback(
    async (signIds: number[]) => {
      if (activeCrewId === null || signIds.length === 0) return;
      setSigns((prev) => {
        const next = { ...prev };
        for (const id of signIds) {
          const s = next[id];
          if (s && s.claimedByCrewId === activeCrewId) {
            next[id] = { ...s, claimedByCrewId: null, claimedByUserId: null };
          }
        }
        return next;
      });
      await enqueueRelease(activeCrewId, signIds);
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, refreshOutbox, syncNow],
  );

  const deploy = useCallback(
    async (signId: number, opts: { notes?: string; photo?: Blob }) => {
      // Optimistic: mark deployed locally; the claim lock is consumed.
      setSigns((prev) => {
        const s = prev[signId];
        if (!s) return prev;
        return {
          ...prev,
          [signId]: {
            ...s,
            status: "deployed",
            deployedAt: new Date().toISOString(),
            claimedByCrewId: null,
            claimedByUserId: null,
          },
        };
      });
      await enqueueDeploy(
        { signId, crewId: activeCrewId, notes: opts.notes },
        opts.photo,
      );
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, refreshOutbox, syncNow],
  );

  const createCrew = useCallback(
    async (name: string) => {
      // Crews need a server-assigned id, so creation is online-only (done at base
      // before hitting the floor). Surfaces a notice when offline.
      try {
        const crew = await api.createCrew(name);
        await bootstrapNow();
        setActiveCrew(crew.id);
      } catch (err) {
        setNotice(
          err instanceof NetworkError
            ? "Can't create a crew while offline — connect first."
            : "Couldn't create the crew.",
        );
      }
    },
    [bootstrapNow, setActiveCrew],
  );

  const joinCrew = useCallback(
    async (crewId: number) => {
      try {
        await api.joinCrew(crewId);
        await bootstrapNow();
        setActiveCrew(crewId);
      } catch (err) {
        setNotice(
          err instanceof NetworkError
            ? "Can't join a crew while offline — connect first."
            : "Couldn't join the crew.",
        );
      }
    },
    [bootstrapNow, setActiveCrew],
  );

  const discardFailed = useCallback(
    async (entry: OutboxEntry) => {
      await deleteEntry(entry.clientId);
      if (entry.kind === "photo") {
        const p = entry.payload as { deployClientId: string };
        await deletePhoto(p.deployClientId);
      }
      await refreshOutbox();
    },
    [refreshOutbox],
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshOutbox();
      try {
        await bootstrapNow();
        if (!cancelled) await syncNow();
      } catch (err) {
        if (!cancelled) {
          setBootError(
            err instanceof NetworkError
              ? "Offline — showing the last data this device saw."
              : "Couldn't load the floor data.",
          );
          // Even if bootstrap failed (offline cold start), the app shell is usable
          // and the outbox still queues; mark loaded so the UI renders.
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapNow, refreshOutbox, syncNow]);

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
    const timer = setInterval(() => {
      void syncNow();
    }, SYNC_INTERVAL_MS);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [syncNow]);

  const pendingCount = outbox.filter((e) => e.status === "pending").length;
  const failedCount = outbox.filter((e) => e.status === "failed").length;

  return {
    loaded,
    bootError,
    online,
    syncing,
    crews,
    myCrewIds,
    activeCrewId,
    signs,
    outbox,
    notice,
    pendingCount,
    failedCount,
    // actions
    setActiveCrew,
    claim,
    release,
    deploy,
    createCrew,
    joinCrew,
    discardFailed,
    syncNow,
    clearNotice: () => setNotice(null),
  };
}
