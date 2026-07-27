// Foreground sync engine for the /signs status-change queue. Like the deploy
// tool, this is NOT the Background Sync API (absent on iOS Safari): the app
// drains the IndexedDB outbox whenever it's in the foreground (on load, on
// reconnect, on a timer, on tab focus). At-least-once replay + server-side
// idempotency (StatusHistory.clientId @unique) makes the net effect exactly-once.

import { MAX_STATUS_BATCH } from "@/lib/deploy/contract";
import { prunableDeadLetters } from "@/lib/offline/dead-letter";

import {
  ApiHttpError,
  NetworkError,
  postSignStatus,
  postSignStatusBatch,
} from "./api";
import { allEntries, deleteEntry, putEntry } from "./idb";
import type { StatusOutboxEntry } from "./types";

// Dead-letter message for a change against a sign the server no longer has
// (e.g. a stale ID lingering in an open tab after a reseed). Surfaced on the
// failed-row badge so the user reloads instead of trusting a phantom "synced".
export const NOT_FOUND_MESSAGE = "This sign no longer exists — reload.";

export type DrainResult = {
  drained: number; // entries the server accepted (applied/duplicate/noop)
  deadLettered: number; // entries moved to the failed dead-letter (permanent 4xx)
  forbidden: number; // entries the server REFUSED (result: "forbidden") — dead-lettered with feedback (#99)
  stoppedOffline: boolean; // drain halted because the network is down
  authExpired: boolean; // a 401 — the session ended; prompt re-auth, keep the queue
};

// Shown on the dead-lettered entry (and its row badge) when the server refuses a
// change — e.g. a volunteer move that needs a claim, or a backward status move.
// The volunteer learns it was rejected instead of it vanishing silently. (#99)
const FORBIDDEN_MESSAGE =
  "The server wouldn't accept this change — you may not have permission, or it's no longer valid.";

// Per-entry outcome:
//   ok   — succeeded; delete the entry.
//   stop — transient (offline / 5xx / 429 / auth-expiry): leave pending and STOP
//          the drain so we don't reorder later entries or hammer a dead floor.
//   dead — permanent (4xx): mark failed (dead-letter) and continue with the rest.
type Outcome = "ok" | "stop" | "dead";

// Both IndexedDB writes below are wrapped: putEntry/deleteEntry CAN reject
// mid-drain (quota exhausted, or iOS Safari closing the connection under a
// backgrounded tab). An unguarded rejection propagated out of drainOutbox, which
// threw away the partial DrainResult — so entries the server had already accepted
// were never reflected, refreshOutbox was skipped and router.refresh never ran,
// leaving rows badged "queued" for changes that had actually landed. One bad
// write must cost that one entry, not the whole drain. Replay stays safe either
// way: the server is idempotent on clientId. (#245)
async function markFailed(
  entry: StatusOutboxEntry,
  message: string,
): Promise<boolean> {
  try {
    await putEntry({
      ...entry,
      queueStatus: "failed",
      attempts: entry.attempts + 1,
      lastError: message,
    });
    return true;
  } catch {
    // Couldn't dead-letter it — leave it pending and try again next drain.
    return false;
  }
}

async function forgetEntry(clientId: string): Promise<boolean> {
  try {
    await deleteEntry(clientId);
    return true;
  } catch {
    // The server has it; we just couldn't clear our copy. It replays harmlessly.
    return false;
  }
}

async function processEntry(
  entry: StatusOutboxEntry,
  acc: DrainResult,
): Promise<Outcome> {
  try {
    // A 2xx result means the change reached the server and was resolved, so the
    // entry won't be replayed. applied/duplicate/noop are DONE (delete the
    // entry). Two results are dead-lettered WITH a reason instead of being
    // silently dropped: "forbidden" (server REFUSED the change, #99) and
    // "not_found" (the sign no longer exists — can never succeed on replay and
    // would otherwise vanish as a phantom "synced").
    const res = await postSignStatus({
      clientId: entry.clientId,
      signId: entry.signId,
      status: entry.status,
      changedAt: new Date(entry.changedAt),
      notes: entry.notes,
    });
    if (res.result === "forbidden") {
      if (await markFailed(entry, FORBIDDEN_MESSAGE)) acc.forbidden += 1;
      return "dead";
    }
    if (res.result === "not_found") {
      if (await markFailed(entry, NOT_FOUND_MESSAGE)) acc.deadLettered += 1;
      return "dead";
    }
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
        if (await markFailed(entry, err.message)) acc.deadLettered += 1;
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

// Bound the dead-letter pile. Failed entries stay in IndexedDB until the user
// discards them by hand, and nothing ever did — so on a shared floor device over
// a multi-day con they accumulate without limit, growing both the store and the
// getAll+sort this queue does on every tick. Keeps the newest MAX_DEAD_LETTERS
// (see lib/offline/dead-letter.ts for why a count, not a TTL). Best-effort: a
// failure here must never break a drain. (#207)
export async function pruneDeadLetters(): Promise<number> {
  try {
    const failed = (await allEntries()).filter((e) => e.queueStatus === "failed");
    const prunable = prunableDeadLetters(failed, (e) => e.createdAt);
    for (const entry of prunable) await deleteEntry(entry.clientId);
    return prunable.length;
  } catch {
    return 0; // IndexedDB unavailable — nothing to prune, nothing to report
  }
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
    forbidden: 0,
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
        const result = byClientId.get(entry.clientId);
        // A result the server didn't echo stays pending for the next drain.
        if (!result) continue;
        if (result.result === "forbidden") {
          // Server refused it. Dead-letter (don't delete) so it surfaces in the
          // queue as failed/discardable instead of vanishing silently. (#99)
          if (await markFailed(entry, FORBIDDEN_MESSAGE)) acc.forbidden += 1;
          continue;
        }
        if (result.result === "not_found") {
          // The sign no longer exists — can never succeed on replay. Dead-letter
          // with feedback so the user reloads instead of trusting a phantom sync.
          if (await markFailed(entry, NOT_FOUND_MESSAGE)) acc.deadLettered += 1;
          continue;
        }
        // applied / duplicate / noop — resolved server-side, nothing to replay.
        // Counted as drained even if the local delete failed: the server DID
        // accept it, so the UI should reconcile to server truth either way.
        await forgetEntry(entry.clientId);
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
              await forgetEntry(entry.clientId);
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
