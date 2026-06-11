// Enqueue a status change: build a durable outbox entry and persist it to
// IndexedDB the instant the user confirms, before any network. The sync engine
// (sync.ts) drains these to the server. Idempotency key = clientId.

import type { SignStatusValue } from "@/lib/deploy/contract";
import { putEntry } from "./idb";
import type { StatusOutboxEntry } from "./types";

function newClientId(): string {
  // crypto.randomUUID needs a secure context (HTTPS/localhost). Fall back to
  // getRandomValues so enqueue never throws and silently drops offline work on a
  // plain-HTTP LAN. (Same belt-and-braces as the deploy outbox.)
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

export async function enqueueStatus(
  signId: number,
  status: SignStatusValue,
  notes?: string | null,
): Promise<StatusOutboxEntry> {
  const entry: StatusOutboxEntry = {
    clientId: newClientId(),
    signId,
    status,
    notes: notes?.trim() ? notes.trim() : undefined,
    changedAt: new Date().toISOString(),
    queueStatus: "pending",
    attempts: 0,
    createdAt: Date.now(),
  };
  await putEntry(entry);
  return entry;
}
