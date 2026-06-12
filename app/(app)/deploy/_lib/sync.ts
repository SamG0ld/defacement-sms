// Foreground sync engine. Deliberately NOT the Background Sync API: that can't
// carry photo bytes and is absent on iOS Safari. Instead the app drains the
// IndexedDB outbox whenever it's in the foreground (on load, on reconnect, on a
// timer, on tab focus) and pulls a delta. At-least-once replay + server-side
// idempotency (clientId @unique) makes the net effect exactly-once.

import {
  ApiHttpError,
  NetworkError,
  getChanges,
  postClaim,
  postDeploy,
  postPhoto,
  postRelease,
} from "./api";
import { allEntries, deleteEntry, deletePhoto, getPhoto, putEntry } from "./idb";
import { MAX_DEPLOY_BATCH, type ClaimRejection } from "@/lib/deploy/contract";
import type {
  ClaimPayload,
  DeployPayload,
  OutboxEntry,
  PhotoPayload,
  ReleasePayload,
} from "./types";

// claim/release/deploy must drain before photos (a photo needs its deploy event
// to already exist server-side).
const KIND_RANK: Record<OutboxEntry["kind"], number> = {
  claim: 0,
  release: 0,
  deploy: 0,
  photo: 1,
};

export type DrainResult = {
  drained: number;
  deadLettered: number;
  stoppedOffline: boolean;
  authExpired: boolean; // a 401 — the session ended; prompt re-auth, keep queue
  claimRejections: ClaimRejection[];
  deployConflicts: number[]; // signIds the server reported as already deployed
};

async function markFailed(entry: OutboxEntry, message: string): Promise<void> {
  await putEntry({
    ...entry,
    status: "failed",
    attempts: entry.attempts + 1,
    lastError: message,
  });
}

// Per-entry outcome:
//   ok   — succeeded; delete the entry.
//   stop — transient (offline / 5xx / 429 / auth-expiry): leave pending and STOP
//          the drain so we don't hammer a dead floor or reorder later entries.
//   dead — permanent (4xx): mark failed (dead-letter) and continue with the rest.
type Outcome = "ok" | "stop" | "dead";

async function processEntry(
  entry: OutboxEntry,
  acc: DrainResult,
): Promise<Outcome> {
  try {
    if (entry.kind === "claim") {
      const p = entry.payload as ClaimPayload;
      const res = await postClaim({ clientId: entry.clientId, ...p });
      acc.claimRejections.push(...res.rejected);
    } else if (entry.kind === "release") {
      const p = entry.payload as ReleasePayload;
      await postRelease({ clientId: entry.clientId, ...p });
    } else if (entry.kind === "deploy") {
      const p = entry.payload as DeployPayload;
      const res = await postDeploy({
        events: [
          {
            clientId: entry.clientId,
            signId: p.signId,
            crewId: p.crewId,
            // Stored as ISO; the contract type is Date (z.coerce.date output).
            // JSON.stringify re-serializes it back to the same ISO string.
            deployedAt: new Date(p.deployedAt),
            notes: p.notes,
            hasPhoto: p.hasPhoto,
          },
        ],
      });
      for (const r of res.results) {
        if (r.status === "conflict") acc.deployConflicts.push(r.signId);
      }
    } else {
      // photo
      const p = entry.payload as PhotoPayload;
      const blob = await getPhoto(p.deployClientId);
      if (!blob) return "ok"; // bytes gone (already uploaded or evicted) — drop
      await postPhoto(p.deployClientId, blob);
      await deletePhoto(p.deployClientId);
    }
    return "ok";
  } catch (err) {
    if (err instanceof NetworkError) return "stop";
    if (err instanceof ApiHttpError) {
      // Session ended mid-floor: the queued work can still succeed after the user
      // re-authenticates, so keep it pending and let the store prompt a re-login.
      if (err.status === 401) {
        acc.authExpired = true;
        return "stop";
      }
      // A photo only reaches the server AFTER its deploy event (drain ordering:
      // deploys rank before photos). So a 404 here means the deploy never landed
      // — it dead-lettered — and this photo will 404 forever. Give up now and DROP
      // THE BYTES (PII: badges/faces must not linger at rest on a shared device).
      if (entry.kind === "photo" && err.status === 404) {
        const p = entry.payload as PhotoPayload;
        await markFailed(entry, "Deploy never synced — photo discarded.");
        await deletePhoto(p.deployClientId);
        acc.deadLettered += 1;
        return "dead";
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

function deployEventOf(entry: OutboxEntry) {
  const p = entry.payload as DeployPayload;
  return {
    clientId: entry.clientId,
    signId: p.signId,
    crewId: p.crewId,
    // Stored as ISO; the contract type is Date (z.coerce.date output).
    // JSON.stringify re-serializes it back to the same ISO string.
    deployedAt: new Date(p.deployedAt),
    notes: p.notes,
    hasPhoto: p.hasPhoto,
  };
}

// Flush a run of consecutive pending deploy entries as chunked batch POSTs —
// one round-trip per MAX_DEPLOY_BATCH instead of per entry, which is the
// difference between a ~1s and a ~20s drain for a 30-50 deploy reconnect on a
// lossy floor. Outcome semantics mirror processEntry; a batch-level permanent
// 4xx (unattributable to one event) falls back to per-entry replay so only the
// offending entry dead-letters.
async function processDeployRun(
  run: OutboxEntry[],
  acc: DrainResult,
): Promise<"ok" | "stop"> {
  for (let i = 0; i < run.length; i += MAX_DEPLOY_BATCH) {
    const chunk = run.slice(i, i + MAX_DEPLOY_BATCH);
    try {
      const res = await postDeploy({ events: chunk.map(deployEventOf) });
      const byClientId = new Map(res.results.map((r) => [r.clientId, r]));
      for (const entry of chunk) {
        const result = byClientId.get(entry.clientId);
        // Defensive: a result the server didn't echo stays pending for the
        // next drain rather than being silently dropped.
        if (!result) continue;
        if (result.status === "conflict") acc.deployConflicts.push(result.signId);
        await deleteEntry(entry.clientId);
        acc.drained += 1;
      }
    } catch (err) {
      if (err instanceof ApiHttpError) {
        if (err.status === 401) {
          acc.authExpired = true;
          return "stop";
        }
        if (err.permanent) {
          // Replay this chunk per-entry: the batch 4xx can't say which event
          // was bad, but individual POSTs dead-letter only the offender.
          for (const entry of chunk) {
            const outcome = await processEntry(entry, acc);
            if (outcome === "ok") {
              await deleteEntry(entry.clientId);
              acc.drained += 1;
            } else if (outcome === "stop") {
              return "stop";
            }
            // "dead": processEntry already marked it failed; keep going.
          }
          continue;
        }
      }
      return "stop"; // NetworkError / 429 / 5xx — leave the rest pending
    }
  }
  return "ok";
}

// Drain every pending entry in FIFO-within-rank order. Dead-lettered (failed)
// entries are skipped — they stay for the UI to surface and the user to discard.
// Consecutive deploy entries batch into one POST (the endpoint takes an events
// array); claims/releases interleaved between them break the run so the FIFO
// claim→deploy ordering for the same sign is preserved.
export async function drainOutbox(): Promise<DrainResult> {
  const acc: DrainResult = {
    drained: 0,
    deadLettered: 0,
    stoppedOffline: false,
    authExpired: false,
    claimRejections: [],
    deployConflicts: [],
  };
  const entries = (await allEntries())
    .filter((e) => e.status === "pending")
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt - b.createdAt);

  let i = 0;
  while (i < entries.length) {
    if (entries[i].kind === "deploy") {
      const run: OutboxEntry[] = [];
      while (i < entries.length && entries[i].kind === "deploy") {
        run.push(entries[i]);
        i += 1;
      }
      if ((await processDeployRun(run, acc)) === "stop") {
        if (!acc.authExpired) acc.stoppedOffline = true;
        break;
      }
      continue;
    }

    const entry = entries[i];
    const outcome = await processEntry(entry, acc);
    if (outcome === "ok") {
      await deleteEntry(entry.clientId);
      acc.drained += 1;
    } else if (outcome === "stop") {
      // Don't flag offline for an auth-expiry — the network is fine, the session
      // isn't; the store surfaces a re-auth prompt instead of an offline badge.
      if (!acc.authExpired) acc.stoppedOffline = true;
      break;
    }
    // "dead": already marked failed; keep going with the rest.
    i += 1;
  }
  return acc;
}

export type SyncResult = DrainResult & {
  changedSigns: import("@/lib/deploy/contract").DeploySignView[];
  cursor: string;
};

// One full sync pass: push local work, then pull what changed. Returns the delta
// for the store to merge plus any conflicts to surface.
export async function syncOnce(cursor: string): Promise<SyncResult> {
  const drain = await drainOutbox();
  const changes = await getChanges(cursor);
  return { ...drain, changedSigns: changes.signs, cursor: changes.cursor };
}
