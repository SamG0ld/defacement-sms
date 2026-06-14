// Foreground sync engine for the /signs status-change queue. Like the deploy
// tool, this is NOT the Background Sync API (absent on iOS Safari): the app
// drains the IndexedDB outbox whenever it's in the foreground (on load, on
// reconnect, on a timer, on tab focus). At-least-once replay + server-side
// idempotency (StatusHistory.clientId @unique) makes the net effect exactly-once.

import { MAX_STATUS_BATCH } from "@/lib/deploy/contract";

import {
  ApiHttpError,
  NetworkError,
  postSignStatus,
  postSignStatusBatch,
} from "./api";
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
    // Any 2xx result — applied, duplicate, noop, not_found, or forbidden — means
    // the change reached the server and was resolved; there's nothing left to
    // replay, so the entry is done. (not_found: the sign was deleted server-side;
    // forbidden: the server rejected the change, e.g. a volunteer move that needs
    // a claim — either way, drop it rather than replay forever.)
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

function statusChangeOf(entry: StatusOutboxEntry) {
  return {
    clientId: entry.clientId,
    signId: entry.signId,
    status: entry.status,
    changedAt: new Date(entry.changedAt),
    notes: entry.notes,
  };
}

// Drain every pending entry in FIFO order, batched into one POST per
// MAX_STATUS_BATCH chunk (the whole queue is the same kind, so unlike the
// deploy drain there are no runs to split). A batch-level permanent 4xx can't
// be attributed to one change, so that chunk replays per-entry and only the
// offender dead-letters. Dead-lettered (failed) entries are skipped — they stay
// for the UI to surface and the user to discard.
export async function drainOutbox(): Promise<DrainResult> {
  const acc: DrainResult = {
    drained: 0,
    deadLettered: 0,
    stoppedOffline: false,
    authExpired: false,
  };
  const entries = (await allEntries()).filter((e) => e.queueStatus === "pending");

  outer: for (let i = 0; i < entries.length; i += MAX_STATUS_BATCH) {
    const chunk = entries.slice(i, i + MAX_STATUS_BATCH);
    try {
      const res = await postSignStatusBatch({
        changes: chunk.map(statusChangeOf),
      });
      const byClientId = new Map(res.results.map((r) => [r.clientId, r]));
      for (const entry of chunk) {
        // Any echoed result — applied, duplicate, noop, not_found, or forbidden
        // — means the change was resolved server-side; nothing left to replay. A
        // result the server didn't echo stays pending for the next drain.
        if (!byClientId.has(entry.clientId)) continue;
        await deleteEntry(entry.clientId);
        acc.drained += 1;
      }
    } catch (err) {
      if (err instanceof ApiHttpError) {
        if (err.status === 401) {
          acc.authExpired = true;
          break;
        }
        if (err.permanent) {
          // Replay this chunk per-entry so only the offending change
          // dead-letters instead of the whole batch.
          for (const entry of chunk) {
            const outcome = await processEntry(entry, acc);
            if (outcome === "ok") {
              await deleteEntry(entry.clientId);
              acc.drained += 1;
            } else if (outcome === "stop") {
              if (!acc.authExpired) acc.stoppedOffline = true;
              break outer;
            }
            // "dead": already marked failed; keep going with the rest.
          }
          continue;
        }
      }
      // NetworkError / 429 / 5xx — leave the rest pending and stop the drain.
      acc.stoppedOffline = true;
      break;
    }
  }
  return acc;
}
