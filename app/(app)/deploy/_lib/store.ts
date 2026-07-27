"use client";

// The floor tool's client state machine. Holds server truth (crews + the
// working sign set + the delta cursor) and the live outbox, and exposes the
// actions the UI calls. Every mutation is optimistic: it lands in the durable
// IndexedDB outbox immediately, then a foreground sync pushes it and pulls the
// reconciled truth back. Works fully offline — actions just queue.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { CrewView, DeploySignView } from "@/lib/deploy/contract";
import { createCircuitBreaker } from "@/lib/offline/circuit-breaker";
import { jitterMs } from "@/lib/offline/jitter";
import { isOnlineNow, subscribeOnline } from "@/lib/offline/online";
import * as api from "./api";
import { NetworkError } from "./api";
import { allEntries, deleteEntry, deletePhoto } from "./idb";
import { applyOutboxOverlay } from "./overlay";
import { enqueueClaim, enqueueDeploy, enqueueRelease } from "./outbox";
import { pruneDeadLetters, syncOnce } from "./sync";
import type { OutboxEntry } from "./types";

const ACTIVE_CREW_KEY = "deploy.activeCrewId";
const SYNC_INTERVAL_MS = 20_000;

// One breaker per engine (module scope — survives remounts). After a run of
// transient sync failures it opens and backs off, so a degraded server isn't
// hammered by every device at the full cadence. 401/403 are not failures. (#81)
const breaker = createCircuitBreaker();

// A fresh mount gets one immediate probe even if the breaker is mid-backoff, so
// a volunteer who navigates away and back to force a sync isn't silently blocked
// for up to 5 minutes. Rate-limited (module scope, like the breaker itself) so
// rapid in/out navigation can't turn the reset into a way to hammer a degraded
// server at will. (#206)
const MOUNT_RESET_MIN_INTERVAL_MS = 30_000;
let lastMountReset = 0;

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
  // Connectivity has two independent inputs, kept separate so neither clobbers
  // the other:
  //  - the browser's own signal, read through useSyncExternalStore. `online`
  //    drives the header badge, i.e. the FIRST rendered DOM, so the server
  //    snapshot is a constant `true` that SSR and the hydration render both
  //    produce; React swaps in the measured value once hydration commits.
  //    Measuring during render instead would mismatch on a phone that is already
  //    offline at page load (React #418 — issue #150), and the online/offline
  //    events can't cover that: they fire on a TRANSITION, never for the state
  //    the browser started in.
  //  - whether the server is actually reachable, which the sync path reports from
  //    a NetworkError / 401 / 403 even while the browser still claims to be online.
  const browserOnline = useSyncExternalStore(
    subscribeOnline,
    isOnlineNow,
    () => true,
  );
  const [serverReachable, setServerReachable] = useState(true);
  const online = browserOnline && serverReachable;
  const [syncing, setSyncing] = useState(false);
  const [crews, setCrews] = useState<CrewView[]>([]);
  const [myCrewIds, setMyCrewIds] = useState<number[]>([]);
  const [activeCrewId, setActiveCrewIdState] = useState<number | null>(() =>
    readActiveCrew(),
  );
  const [signs, setSigns] = useState<Record<number, DeploySignView>>({});
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // True while the circuit breaker is refusing ticks. Surfaced in the UI so a
  // backed-off tool reads as "waiting" rather than "hung". (#206)
  const [backingOff, setBackingOff] = useState(false);

  const cursorRef = useRef<string>("");
  const syncingRef = useRef(false);
  const mountedRef = useRef(true);
  // One-shot latch for the poisoned-cursor recovery, so a genuinely persistent
  // 400 can't re-bootstrap on every 20s tick. Cleared by any clean pull. (#208)
  const cursorRecoveredRef = useRef(false);

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
    // Server truth is the BASE, not the whole answer: it knows nothing about work
    // still sitting in this device's outbox. Replay the pending queue over it, or
    // a mid-shift reload (or an iOS Safari tab reap) silently reverts claims and
    // deploys the volunteer can still see listed in the queue panel — which reads
    // as lost work and invites re-claiming a sign they already hold. Read the
    // outbox from IndexedDB rather than React state so a cold start replays it
    // too. (#184)
    let pending: OutboxEntry[] = [];
    try {
      pending = await allEntries();
    } catch {
      /* IndexedDB unavailable — nothing to replay; server truth stands alone */
    }
    const base = Object.fromEntries(data.signs.map((s) => [s.id, s]));
    setSigns(applyOutboxOverlay(base, pending, currentUserId));
    cursorRef.current = data.cursor;
    setLoaded(true);
    setBootError(null);
  }, [currentUserId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!breaker.canRequest()) {
      // Circuit open — skip this tick (#81). SAY so: silence here looks identical
      // to a hung tool at the exact moment a volunteer is trying to recover. (#206)
      setBackingOff(true);
      return;
    }
    setBackingOff(false);
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await syncOnce(cursorRef.current);
      cursorRef.current = res.cursor;
      const pull = res.pullError;
      // Settle durable/shared state BEFORE the mounted-guard: feed the breaker so a
      // half-open probe is ALWAYS resolved even if we unmounted mid-sync (else the
      // next canRequest wedges). Exactly ONE of onSuccess/onFailure must run.
      // A transient stop (network / 5xx / 429) in EITHER half — the push drain or
      // the delta pull — is a failure; a clean pass, and any failure that means the
      // SESSION or ACCOUNT rather than the server (401/403) or a client-side bug
      // (permanent 4xx), closes it. (#81/#105/#183)
      const degraded =
        res.stoppedOffline ||
        pull?.kind === "network" ||
        pull?.kind === "rate-limited" ||
        pull?.kind === "transient";
      if (degraded) breaker.onFailure();
      else breaker.onSuccess();
      // A clean pull re-arms the poisoned-cursor recovery for a future poisoning.
      if (!pull) cursorRecoveredRef.current = false;
      // Unmounted mid-sync — skip the React updates that would just no-op on a dead
      // tree (the cursor / breaker are already settled above). (#105)
      if (!mountedRef.current) return;
      mergeSigns(res.changedSigns);
      // Apply uploaded photo URLs straight from the upload responses so a freshly
      // deployed sign shows its photo THIS session — without waiting on (or racing
      // a failed) delta pull whose cursor may already have advanced past it. (#100)
      if (res.photoApplied.length > 0) {
        setSigns((prev) => {
          const next = { ...prev };
          for (const pa of res.photoApplied) {
            const s = next[pa.signId];
            if (s) next[pa.signId] = { ...s, deployPhotoUrl: pa.photoUrl };
          }
          return next;
        });
      }
      // The server is unreachable when the drain stopped offline, or when the pull
      // failed in a way that means we genuinely couldn't talk to it (network) or
      // aren't allowed to (401/403). A 429/5xx/permanent-4xx pull leaves the flag
      // alone — same as before, the drain half already spoke for reachability.
      if (
        pull?.kind === "network" ||
        pull?.kind === "auth-expired" ||
        pull?.kind === "forbidden"
      ) {
        setServerReachable(false);
      } else if (!pull) {
        setServerReachable(!res.stoppedOffline);
      }

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
      // The delta pull is the SECOND half of a sync; these notices used to live in
      // the catch, where they cost us the entire drain result to reach. (#183)
      if (pull?.kind === "auth-expired" && !res.authExpired) {
        // A 401 from the changes-PULL (the push drain reports auth-expiry in-band)
        // was once swallowed entirely: `online` stayed true and the queue silently
        // never drained, with no re-auth prompt. (#85)
        msgs.push(
          "Your session ended — reload and sign in to sync your queued work.",
        );
      }
      if (pull?.kind === "forbidden") {
        // 403 from the changes-PULL means a deactivated account (#79). With an
        // empty outbox the push drain surfaces nothing, so without this the deploy
        // screen would silently keep re-pulling with no signal. (#85/#79)
        msgs.push("Your access has been revoked — contact a lead to restore it.");
      }
      setNotice(msgs.length > 0 ? msgs.join(" ") : null);
      await refreshOutbox();

      // A non-empty but unparseable cursor 400s on every tick, forever, with zero
      // signal: the breaker stays closed (a permanent 4xx is a client bug, not
      // server health), so the tool keeps retrying at full cadence while the delta
      // never advances and the crew silently stops seeing other crews' work. Treat
      // it as a poisoned cursor and re-bootstrap once to obtain a fresh one. (#208)
      if (pull?.kind === "permanent" && !cursorRecoveredRef.current) {
        cursorRecoveredRef.current = true;
        try {
          await bootstrapNow();
        } catch {
          // The recovery itself failed (offline / 5xx / 429 from the burst). Re-arm
          // the latch: leaving it set would wedge the delta pull for the life of
          // the mount, with the tool still looking healthy, and no clean pull could
          // ever re-arm it.
          cursorRecoveredRef.current = false;
          if (mountedRef.current) {
            // Append rather than replace — msgs above may carry dead-letter or
            // conflict counts the crew still needs.
            setNotice((prev) =>
              prev
                ? `${prev} Couldn't refresh the floor data — reload once you have signal.`
                : "Couldn't refresh the floor data — reload once you have signal.",
            );
          }
        }
      }

      // Keep the dead-letter pile bounded WITHIN a long-lived session too: a
      // device parked on this screen for a whole shift never remounts, so a
      // mount-only prune would let it grow all con. (#207)
      if (res.deadLettered > 0) await pruneDeadLetters();
    } catch {
      // syncOnce absorbs every transport failure into res.pullError, so anything
      // reaching here is an unexpected CLIENT-side throwable (an IndexedDB fault, a
      // bug in the merge) — not a server signal. Resolve the half-open probe
      // without backing off, BEFORE the mounted guard so it can never wedge. (#81)
      breaker.onSuccess();
      // Unmounted mid-sync — skip the React updates that would just no-op on a dead
      // tree. The success path has always done this; the catch didn't, which left
      // the two arms inconsistent and would have masked a real leak if these
      // setters ever gained side effects. (#105/#244)
      if (!mountedRef.current) return;
      // Don't fail silently: the queue is intact, but the volunteer should know
      // this tick didn't land rather than watch a queue that never moves. Never
      // CLOBBER a live notice though — a standing "your session ended" / "access
      // revoked" is far more actionable than this, and replacing it with
      // reassurance would be actively misleading.
      setNotice(
        (prev) =>
          prev ?? "Couldn't sync just now — your queued work is safe and will retry.",
      );
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [bootstrapNow, mergeSigns, refreshOutbox]);

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
      // Durable FIRST: land the claim in the IndexedDB outbox BEFORE the
      // optimistic overlay. If the write throws (quota, private mode), surface it
      // and bail — never leave a phantom "claimed" the server never heard about.
      // Mirrors the createCrew/joinCrew pattern below. (#64)
      let entries;
      try {
        entries = await enqueueClaim(activeCrewId, signIds);
      } catch {
        setNotice("Couldn't save the claim on this device — try again.");
        // Rethrow so the call site keeps the user's selection to retry rather
        // than clearing it as if the claim had been recorded.
        throw new Error("claim enqueue failed");
      }
      // Optimistic: show the signs as claimed by my crew now that it's stored.
      // Projected by the SAME pure fold that bootstrap replays, so what you see
      // after an action and what you see after a reload can't drift apart. (#184)
      setSigns((prev) => applyOutboxOverlay(prev, entries, currentUserId));
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, currentUserId, refreshOutbox, syncNow],
  );

  const release = useCallback(
    async (signIds: number[]) => {
      if (activeCrewId === null || signIds.length === 0) return;
      // Durable FIRST, then the optimistic overlay — same as claim/deploy. A
      // dropped IndexedDB write must not show a release the server never got. (#64/#65)
      let entries;
      try {
        entries = await enqueueRelease(activeCrewId, signIds);
      } catch {
        setNotice("Couldn't save the release on this device — try again.");
        throw new Error("release enqueue failed");
      }
      setSigns((prev) => applyOutboxOverlay(prev, entries, currentUserId));
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, currentUserId, refreshOutbox, syncNow],
  );

  const deploy = useCallback(
    async (signId: number, opts: { notes?: string; photo?: Blob }) => {
      // Durable FIRST: persist the deploy (and its photo bytes) BEFORE the
      // optimistic "deployed" overlay. A swallowed IndexedDB write here is the
      // worst field failure — the sign reads deployed while the server has no
      // record — so surface it and bail instead of faking success. (#64)
      let entry;
      try {
        entry = await enqueueDeploy(
          { signId, crewId: activeCrewId, notes: opts.notes },
          opts.photo,
        );
      } catch {
        setNotice("Couldn't save the deployment on this device — try again.");
        // Rethrow so the call site keeps the deploy sheet (and its captured
        // photo) open to retry instead of closing as if it had been recorded.
        throw new Error("deploy enqueue failed");
      }
      // Optimistic: mark deployed locally now that it's stored; the claim lock is
      // consumed. Uses the entry's OWN deployedAt so the optimistic timestamp and
      // the one that eventually reaches the server are the same instant. (#184)
      setSigns((prev) => applyOutboxOverlay(prev, [entry], currentUserId));
      await refreshOutbox();
      void syncNow();
    },
    [activeCrewId, currentUserId, refreshOutbox, syncNow],
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
      // Guard the IDB writes: a discard is fire-and-forget at the call site, so an
      // unhandled rejection here would surface as a swallowed promise. (#60)
      try {
        // Delete the photo BYTES first, the outbox entry last: if the photo
        // delete fails, the entry stays so the user can genuinely retry — and a
        // partial failure never orphans PII bytes (badges/faces) under an
        // already-removed entry where nothing would ever clean them up. (#60)
        if (entry.kind === "photo") {
          const p = entry.payload as { deployClientId: string };
          await deletePhoto(p.deployClientId);
        }
        await deleteEntry(entry.clientId);
        await refreshOutbox();
      } catch {
        setNotice("Couldn't discard that item — try again.");
      }
    },
    [refreshOutbox],
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  // Track mount so a sync that resolves AFTER unmount skips its React state
  // updates (the durable cursor / breaker / outbox are settled regardless). (#105)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Coming back to this screen is a deliberate "sync now" gesture. The breaker
      // is module-scoped so an earlier backoff window is still ticking; give this
      // mount one probe regardless, rate-limited so repeated in/out navigation
      // can't be used to hammer a genuinely degraded server. (#206)
      const now = Date.now();
      if (now - lastMountReset >= MOUNT_RESET_MIN_INTERVAL_MS) {
        lastMountReset = now;
        breaker.probeOnce();
        setBackingOff(false);
      }
      // Trim the dead-letter pile before the first read, so a shared device used
      // across a multi-day con doesn't carry an unbounded queue into every
      // tick's getAll+sort. (#207)
      await pruneDeadLetters();
      if (cancelled) return;
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
    let onlineTimer: number | undefined;
    // The badge itself now follows `browserOnline`; this listener exists to give
    // the server-reachability flag the benefit of the doubt on reconnect and to
    // kick a sync. (There's no matching "offline" handler any more — the external
    // store already reports that.)
    const goOnline = () => {
      setServerReachable(true);
      // Jitter the reconnect sync: at a venue with RF blips every device's
      // `online` fires near-simultaneously — a 0–5s spread keeps them from
      // hammering the small pg pool in a synchronized burst. (#80)
      onlineTimer = window.setTimeout(() => void syncNow(), jitterMs());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    window.addEventListener("online", goOnline);
    document.addEventListener("visibilitychange", onVisible);
    // Stagger the interval's START (0–20s) so devices that loaded together don't
    // align their ticks into a synchronized wave; it then runs every 20s. (#80)
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
    backingOff,
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
