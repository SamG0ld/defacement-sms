// Client-side types for the offline floor tool. Wire shapes live in
// lib/deploy/contract.ts (shared with the server); these describe the local
// IndexedDB outbox and the derived UI state.

import type { DeploySignView } from "@/lib/deploy/contract";

// A queued mutation waiting to reach the server. The outbox is the durable
// source of truth for "what this device did that the server may not have yet" —
// it survives reloads (IndexedDB) so a crew that closes the app mid-floor never
// loses a claim or deploy. Idempotency is by `clientId` (the store key), so an
// at-least-once replay is exactly-once server-side.
export type OutboxKind = "claim" | "release" | "deploy" | "photo";

export type OutboxStatus = "pending" | "failed";

// Discriminated payloads — each kind carries exactly what its endpoint needs.
export type ClaimPayload = { crewId: number; signIds: number[] };
export type ReleasePayload = { crewId: number; signIds: number[] };
export type DeployPayload = {
  signId: number;
  crewId: number | null;
  deployedAt: string; // ISO — the client's local deploy instant
  notes?: string;
  hasPhoto: boolean;
};
// The photo bytes live in a separate IndexedDB store keyed by the SAME clientId
// as the deploy event, so the upload can find them after the deploy applies.
export type PhotoPayload = { signId: number; deployClientId: string };

export type OutboxEntry = {
  clientId: string; // idempotency key + store key
  kind: OutboxKind;
  payload: ClaimPayload | ReleasePayload | DeployPayload | PhotoPayload;
  status: OutboxStatus;
  attempts: number;
  createdAt: number; // epoch ms — FIFO ordering
  lastError?: string; // set when status === "failed" (dead-letter, surfaced in UI)
};

// The merged view the UI renders: server truth overlaid with the optimistic
// effect of anything still in the outbox.
export type DisplaySign = DeploySignView & {
  pending: boolean; // a not-yet-synced local op touches this sign
};
