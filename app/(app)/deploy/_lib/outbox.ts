// Enqueue helpers: build a durable outbox entry (and stash photo bytes) for each
// local mutation, then persist to IndexedDB. The store calls these optimistically
// the instant the user acts; the sync engine (sync.ts) drains them to the server.

import { MAX_CLAIM_BATCH } from "@/lib/deploy/contract";

import { putEntry, putPhoto } from "./idb";
import type {
  ClaimPayload,
  DeployPayload,
  OutboxEntry,
  ReleasePayload,
} from "./types";

// Split a batch of signIds so no single entry can exceed the server's cap. The
// deploy and status drains already chunk their POSTs; claim/release had no
// exported cap to chunk against, so a "claim this whole zone" over the limit ate
// a hard Zod 400 with no client-side fallback — on a floor where the volunteer
// can't do anything about it. Chunking at ENQUEUE (rather than at POST) keeps
// each request's body identical to exactly one durable entry and its own
// clientId, so a drain that stops halfway keeps the chunks that already landed
// instead of replaying the whole batch. (#214)
function chunkSignIds(signIds: number[]): number[][] {
  if (signIds.length <= MAX_CLAIM_BATCH) return [signIds];
  const chunks: number[][] = [];
  for (let i = 0; i < signIds.length; i += MAX_CLAIM_BATCH) {
    chunks.push(signIds.slice(i, i + MAX_CLAIM_BATCH));
  }
  return chunks;
}

function newClientId(): string {
  // crypto.randomUUID needs a secure context (HTTPS/localhost) — which the PWA
  // already requires for the service worker to register at all. Fall back to
  // getRandomValues just in case the tool is ever reached over plain HTTP on a
  // LAN, so enqueue never throws and silently drops offline work.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base(clientId: string): Pick<
  OutboxEntry,
  "clientId" | "status" | "attempts" | "createdAt"
> {
  return { clientId, status: "pending", attempts: 0, createdAt: Date.now() };
}

export async function enqueueClaim(
  crewId: number,
  signIds: number[],
): Promise<OutboxEntry[]> {
  const entries: OutboxEntry[] = [];
  const chunks = chunkSignIds(signIds);
  for (const [i, chunk] of chunks.entries()) {
    const entry: OutboxEntry = {
      ...base(newClientId()),
      kind: "claim",
      // Stagger createdAt per chunk: they're written within the same millisecond,
      // and the drain (and allEntries) order by createdAt — equal values would
      // leave the chunks in IndexedDB key order, i.e. random UUID order.
      createdAt: Date.now() + i,
      payload: { crewId, signIds: chunk } satisfies ClaimPayload,
    };
    await putEntry(entry);
    entries.push(entry);
  }
  return entries;
}

export async function enqueueRelease(
  crewId: number,
  signIds: number[],
): Promise<OutboxEntry[]> {
  const entries: OutboxEntry[] = [];
  const chunks = chunkSignIds(signIds);
  for (const [i, chunk] of chunks.entries()) {
    const entry: OutboxEntry = {
      ...base(newClientId()),
      kind: "release",
      createdAt: Date.now() + i, // see enqueueClaim — keeps chunk order stable
      payload: { crewId, signIds: chunk } satisfies ReleasePayload,
    };
    await putEntry(entry);
    entries.push(entry);
  }
  return entries;
}

// A deploy is up to TWO entries that share the deploy's clientId: the deploy
// event, and (optionally) a photo upload. The photo bytes go to the photos store
// under the same clientId so the upload can find them after the event applies.
export async function enqueueDeploy(
  args: {
    signId: number;
    crewId: number | null;
    notes?: string;
  },
  photo?: Blob,
): Promise<OutboxEntry> {
  const clientId = newClientId();
  const deploy: OutboxEntry = {
    ...base(clientId),
    kind: "deploy",
    payload: {
      signId: args.signId,
      crewId: args.crewId,
      deployedAt: new Date().toISOString(),
      notes: args.notes,
    } satisfies DeployPayload,
  };
  await putEntry(deploy);

  if (photo) {
    await putPhoto(clientId, photo);
    const photoEntry: OutboxEntry = {
      ...base(newClientId()),
      kind: "photo",
      // createdAt is bumped a tick so the photo always sorts after its deploy.
      createdAt: deploy.createdAt + 1,
      payload: { signId: args.signId, deployClientId: clientId },
    };
    await putEntry(photoEntry);
  }
  return deploy;
}
