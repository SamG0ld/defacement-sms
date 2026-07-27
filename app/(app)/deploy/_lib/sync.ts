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
import { classifyHttpStatus } from "@/lib/offline/http-classification";
import { prunableDeadLetters } from "@/lib/offline/dead-letter";
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
  photoApplied: { signId: number; photoUrl: string }[]; // uploaded photos to reflect locally (#100)
};

// Guarded like the /signs twin: putEntry CAN reject mid-drain (quota exhausted,
// or iOS Safari closing the connection under a backgrounded tab). An unguarded
// rejection propagates out of drainOutbox → syncOnce and takes the whole
// DrainResult with it — and by that point uploaded photos' BYTES are already
// deleted from IndexedDB, so acc.photoApplied is their only in-session record.
// That's the exact loss #183 exists to prevent, reachable through a different
// door. One bad write must cost one entry, not the drain. (#183/#245)
async function markFailed(
  entry: OutboxEntry,
  message: string,
): Promise<boolean> {
  try {
    await putEntry({
      ...entry,
      status: "failed",
      attempts: entry.attempts + 1,
      lastError: message,
    });
    return true;
  } catch {
    return false; // couldn't dead-letter it — stays pending, retried next drain
  }
}

// Record one more unsuccessful attempt WITHOUT dead-lettering, so a deliberately
// deferred entry can't defer forever. Best-effort: a failed bookkeeping write
// just means this attempt isn't counted.
async function bumpAttempts(entry: OutboxEntry): Promise<void> {
  try {
    await putEntry({ ...entry, attempts: entry.attempts + 1 });
  } catch {
    /* couldn't record the attempt — the ceiling is approached more slowly */
  }
}

// How many drains a photo may wait for a deploy that the server never confirms
// before we give up and discard its bytes. Without a ceiling, "keep the bytes
// while the deploy is pending" is an UNBOUNDED retention window for badge/face
// PII on a shared device, since nothing forces an un-echoed deploy to resolve.
const MAX_PHOTO_DEFERRALS = 10;

// Per-entry outcome:
//   ok   — succeeded; delete the entry.
//   stop — transient (offline / 5xx / 429 / auth-expiry): leave pending and STOP
//          the drain so we don't hammer a dead floor or reorder later entries.
//   dead — permanent (4xx): mark failed (dead-letter) and continue with the rest.
//   skip — not resolvable YET but not a failure either: leave the entry pending
//          and CONTINUE the drain (unlike "stop", the network is fine). Only the
//          photo-before-its-deploy case uses this. (#246)
type Outcome = "ok" | "stop" | "dead" | "skip";

// Drain-scoped bookkeeping that a single entry can't derive on its own.
type DrainContext = {
  // Deploy entries that were pending when this drain STARTED and have not been
  // resolved (drained or dead-lettered) since. A photo whose deploy is still in
  // here must not treat its own 404 as permanent — the deploy is going to retry
  // and succeed, and discarding the bytes now would leave the deployed sign
  // permanently photo-less. (#246)
  unresolvedDeploys: Set<string>;
};

async function processEntry(
  entry: OutboxEntry,
  acc: DrainResult,
  ctx: DrainContext,
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
      const res = await postPhoto(p.deployClientId, blob);
      // Surface the gated URL so the store can show the photo this session
      // without waiting on (or racing) the delta pull that carries it. (#100)
      // Only when the server actually cached it on the sign: a deploy that lost
      // its race keeps its photo on the event, but the sign's photo belongs to the
      // winning deploy, so painting this one on would show the wrong photo until
      // the next delta corrected it. (#231)
      if (res.cachedOnSign) {
        acc.photoApplied.push({ signId: p.signId, photoUrl: res.photoUrl });
      }
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
      // deploys rank before photos). So a 404 here normally means the deploy never
      // landed — it dead-lettered — and this photo will 404 forever. Give up and
      // DROP THE BYTES (PII: badges/faces must not linger at rest on a shared
      // device).
      //
      // "Normally" is load-bearing: the batch path leaves a deploy the server
      // didn't echo PENDING and carries on, so a photo can be reached while its
      // deploy is still queued. That deploy WILL retry and succeed on the next
      // drain, so discarding the bytes here would permanently strip the photo off
      // a sign that does get deployed. Only dead-letter once the deploy is
      // actually resolved (or was never queued on this device). (#246)
      if (entry.kind === "photo" && err.status === 404) {
        const p = entry.payload as PhotoPayload;
        // …but only defer a BOUNDED number of times: an un-echoed deploy has
        // nothing forcing it to resolve, so an unbounded wait would keep badge/
        // face bytes at rest on a shared device indefinitely.
        if (
          ctx.unresolvedDeploys.has(p.deployClientId) &&
          entry.attempts < MAX_PHOTO_DEFERRALS
        ) {
          await bumpAttempts(entry);
          return "skip";
        }
        if (await markFailed(entry, "Deploy never synced — photo discarded.")) {
          acc.deadLettered += 1;
        }
        await deletePhoto(p.deployClientId);
        return "dead";
      }
      if (err.permanent) {
        // A permanent failure won't succeed on replay. For a photo that also
        // means its bytes (badge/face PII) must not linger at rest on a shared
        // device — discard them alongside the dead-letter, same as the 404 case
        // above (this arm catches the non-404 permanents: 400/413/403/…).
        if (entry.kind === "photo") {
          const p = entry.payload as PhotoPayload;
          await deletePhoto(p.deployClientId);
        }
        if (await markFailed(entry, err.message)) acc.deadLettered += 1;
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
  ctx: DrainContext,
): Promise<"ok" | "stop"> {
  for (let i = 0; i < run.length; i += MAX_DEPLOY_BATCH) {
    const chunk = run.slice(i, i + MAX_DEPLOY_BATCH);
    try {
      const res = await postDeploy({ events: chunk.map(deployEventOf) });
      const byClientId = new Map(res.results.map((r) => [r.clientId, r]));
      for (const entry of chunk) {
        const result = byClientId.get(entry.clientId);
        // Defensive: a result the server didn't echo stays pending for the
        // next drain rather than being silently dropped. It also stays in
        // ctx.unresolvedDeploys so its photo waits for it. (#246)
        if (!result) continue;
        if (result.status === "conflict") acc.deployConflicts.push(result.signId);
        await deleteEntry(entry.clientId);
        ctx.unresolvedDeploys.delete(entry.clientId);
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
            const outcome = await processEntry(entry, acc, ctx);
            if (outcome === "ok") {
              await deleteEntry(entry.clientId);
              acc.drained += 1;
            } else if (outcome === "stop") {
              return "stop";
            }
            // "dead": processEntry already marked it failed; keep going. Either
            // way the deploy is settled — its photo may stop waiting. (#246)
            ctx.unresolvedDeploys.delete(entry.clientId);
          }
          continue;
        }
      }
      return "stop"; // NetworkError / 429 / 5xx — leave the rest pending
    }
  }
  return "ok";
}

// Bound the dead-letter pile — see the /signs twin and lib/offline/dead-letter.ts.
// Photo dead-letters already discard their bytes at dead-letter time, but delete
// again defensively: pruning the row is the last chance to notice orphaned PII
// (badges/faces) still sitting at rest on a shared device. Best-effort. (#207)
export async function pruneDeadLetters(): Promise<number> {
  try {
    const failed = (await allEntries()).filter((e) => e.status === "failed");
    const prunable = prunableDeadLetters(failed, (e) => e.createdAt);
    for (const entry of prunable) {
      if (entry.kind === "photo") {
        const p = entry.payload as PhotoPayload;
        await deletePhoto(p.deployClientId);
      }
      await deleteEntry(entry.clientId);
    }
    return prunable.length;
  } catch {
    return 0; // IndexedDB unavailable — nothing to prune, nothing to report
  }
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
    photoApplied: [],
  };
  const entries = (await allEntries())
    .filter((e) => e.status === "pending")
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt - b.createdAt);

  const ctx: DrainContext = {
    unresolvedDeploys: new Set(
      entries.filter((e) => e.kind === "deploy").map((e) => e.clientId),
    ),
  };

  let i = 0;
  while (i < entries.length) {
    if (entries[i].kind === "deploy") {
      const run: OutboxEntry[] = [];
      while (i < entries.length && entries[i].kind === "deploy") {
        run.push(entries[i]);
        i += 1;
      }
      if ((await processDeployRun(run, acc, ctx)) === "stop") {
        if (!acc.authExpired) acc.stoppedOffline = true;
        break;
      }
      continue;
    }

    const entry = entries[i];
    const outcome = await processEntry(entry, acc, ctx);
    if (outcome === "ok") {
      await deleteEntry(entry.clientId);
      acc.drained += 1;
    } else if (outcome === "stop") {
      // Don't flag offline for an auth-expiry — the network is fine, the session
      // isn't; the store surfaces a re-auth prompt instead of an offline badge.
      if (!acc.authExpired) acc.stoppedOffline = true;
      break;
    }
    // "dead": already marked failed. "skip": deliberately left pending (#246).
    // Either way, keep going with the rest.
    i += 1;
  }

  // Both lists are reported to the user as COUNTS ("N sign(s) were already
  // deployed by another crew"), so a signId observed twice — the per-entry replay
  // after a batch 4xx re-reports conflicts the batch may have partially seen —
  // would overstate how many signs are actually affected. Dedupe by signId,
  // keeping the latest observation as the truthiest. (#204)
  acc.deployConflicts = [...new Set(acc.deployConflicts)];
  acc.claimRejections = [
    ...new Map(acc.claimRejections.map((r) => [r.signId, r])).values(),
  ];
  return acc;
}

// Why the delta pull failed, when it did. Reuses the shared HTTP taxonomy plus
// "network" for a request that never reached the server. (#183)
export type PullError = {
  kind: import("@/lib/offline/http-classification").HttpCategory | "network";
};

export type SyncResult = DrainResult & {
  changedSigns: import("@/lib/deploy/contract").DeploySignView[];
  cursor: string;
  pullError?: PullError; // set when the delta pull failed; the drain result is still valid
};

// One full sync pass: push local work, then pull what changed. Returns the delta
// for the store to merge plus any conflicts to surface.
//
// TOTAL for pull failures — it never throws one. The push half runs FIRST and its
// side-effects are irreversible and partly unrecoverable: photo bytes are deleted
// from IndexedDB the moment their upload succeeds, so `photoApplied` is the only
// in-session record of those URLs. Letting a failed pull throw meant the store's
// `await syncOnce(...)` never bound and the whole DrainResult — uploaded photos,
// claim-rejection reconciliation, conflict and dead-letter counts — was discarded
// at exactly the moment the crew is told to re-authenticate. Classify the failure,
// return the drain intact, and let the store decide. (#183)
export async function syncOnce(cursor: string): Promise<SyncResult> {
  const drain = await drainOutbox();
  // Before bootstrap lands a cursor, an event-triggered sync (online / visibility)
  // can call this with "" — the changes endpoint requires a `since` and would 400.
  // Drain the outbox regardless (it needs no cursor) but skip the delta pull until
  // the cursor exists; bootstrap fills it in. (#66)
  if (cursor === "") {
    return { ...drain, changedSigns: [], cursor };
  }
  try {
    const changes = await getChanges(cursor);
    return { ...drain, changedSigns: changes.signs, cursor: changes.cursor };
  } catch (err) {
    // Only the two transport failure modes are absorbed. Anything else is a
    // genuine client-side bug, not a pull outcome — rethrow so the store's
    // unknown-throwable arm still sees it rather than mislabelling it "offline".
    if (!(err instanceof NetworkError) && !(err instanceof ApiHttpError)) throw err;
    // Hold the cursor where it was: advancing it on a failed pull would skip the
    // very changes we didn't receive.
    const kind: PullError["kind"] =
      err instanceof ApiHttpError ? classifyHttpStatus(err.status) : "network";
    return { ...drain, changedSigns: [], cursor, pullError: { kind } };
  }
}
