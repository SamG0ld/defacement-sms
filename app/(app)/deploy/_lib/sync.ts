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
import type { ClaimRejection } from "@/lib/deploy/contract";
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

// Drain every pending entry in FIFO-within-rank order. Dead-lettered (failed)
// entries are skipped — they stay for the UI to surface and the user to discard.
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

  for (const entry of entries) {
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
