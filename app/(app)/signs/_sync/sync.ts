// Foreground sync engine for the /signs status-change queue. Like the deploy
// tool, this is NOT the Background Sync API (absent on iOS Safari): the app
// drains the IndexedDB outbox whenever it's in the foreground (on load, on
// reconnect, on a timer, on tab focus). At-least-once replay + server-side
// idempotency (StatusHistory.clientId @unique) makes the net effect exactly-once.

import { ApiHttpError, NetworkError, postSignStatus } from "./api";
import { allEntries, deleteEntry, putEntry } from "./idb";
import type { StatusOutboxEntry } from "./types";

export type DrainResult = {
  drained: number; // entries the server accepted (applied/duplicate/noop/not_found)
  deadLettered: number; // entries moved to the failed dead-letter (permanent 4xx)
  stoppedOffline: boolean; // drain halted because the network is down
  authExpired: boolean; // a 401 — the session ended; prompt re-auth, keep the queue
};

// Per-entry outcome:
//   ok   — succeeded; delete the entry.
//   stop — transient (offline / 5xx / 429 / auth-expiry): leave pending and STOP
//          the drain so we don't reorder later entries or hammer a dead floor.
//   dead — permanent (4xx): mark failed (dead-letter) and continue with the rest.
type Outcome = "ok" | "stop" | "dead";

async function markFailed(entry: StatusOutboxEntry, message: string): Promise<void> {
  await putEntry({
    ...entry,
    queueStatus: "failed",
    attempts: entry.attempts + 1,
    lastError: message,
  });
}

async function processEntry(
  entry: StatusOutboxEntry,
  acc: DrainResult,
): Promise<Outcome> {
  try {
    // Any 2xx result — applied, duplicate, noop, or not_found — means the change
    // reached the server and was resolved; there's nothing left to replay, so the
    // entry is done. (not_found: the sign was deleted server-side; drop it.)
    await postSignStatus({
      clientId: entry.clientId,
      signId: entry.signId,
      status: entry.status,
      changedAt: new Date(entry.changedAt),
      notes: entry.notes,
    });
    return "ok";
  } catch (err) {
    if (err instanceof NetworkError) return "stop";
    if (err instanceof ApiHttpError) {
      if (err.status === 401) {
        // Session ended mid-floor: the queued change can still succeed after the
        // user re-authenticates, so keep it pending and surface a re-auth prompt.
        acc.authExpired = true;
        return "stop";
      }
      if (err.permanent) {
        await markFailed(entry, err.message);
        acc.deadLettered += 1;
        return "dead";
      }
      return "stop"; // 429 / 5xx
    }
    return "stop";
  }
}

// Drain every pending entry in FIFO order. Dead-lettered (failed) entries are
// skipped — they stay for the UI to surface and the user to discard.
export async function drainOutbox(): Promise<DrainResult> {
  const acc: DrainResult = {
    drained: 0,
    deadLettered: 0,
    stoppedOffline: false,
    authExpired: false,
  };
  const entries = (await allEntries()).filter((e) => e.queueStatus === "pending");

  for (const entry of entries) {
    const outcome = await processEntry(entry, acc);
    if (outcome === "ok") {
      await deleteEntry(entry.clientId);
      acc.drained += 1;
    } else if (outcome === "stop") {
      // Don't flag offline for an auth-expiry — the network is fine, the session
      // isn't; the provider surfaces a re-auth prompt instead of an offline badge.
      if (!acc.authExpired) acc.stoppedOffline = true;
      break;
    }
    // "dead": already marked failed; keep going with the rest.
  }
  return acc;
}
