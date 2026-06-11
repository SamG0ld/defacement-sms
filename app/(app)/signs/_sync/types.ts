// Client-side types for the durable /signs status-change queue (M11 #2). The
// wire shape lives in lib/deploy/contract.ts (setSignStatusSchema, shared with
// the server); this describes the local IndexedDB outbox and the derived UI
// overlay.
//
// This is a deliberate, focused COPY of the /deploy offline engine's shapes
// (app/(app)/deploy/_lib), scoped to a single mutation kind — a status change —
// so the con-critical deploy path stays untouched. A shared offline-outbox core
// is logged as tech debt to extract later.

import type { SignStatusValue } from "@/lib/deploy/contract";

// A queued status change waiting to reach the server. The outbox is the durable
// record of "a status this device set that the server may not have yet" — it
// survives reloads (IndexedDB), so a volunteer who drops signal (or closes the
// tab) mid-floor never silently loses the change. Idempotency is by `clientId`
// (the store key + StatusHistory.clientId @unique), so an at-least-once replay
// is exactly-once server-side.
export type StatusQueueState = "pending" | "failed";

export type StatusOutboxEntry = {
  clientId: string; // idempotency key + store key
  signId: number;
  status: SignStatusValue; // the target status
  notes?: string;
  changedAt: string; // ISO — the client's local change instant
  queueStatus: StatusQueueState;
  attempts: number;
  createdAt: number; // epoch ms — FIFO ordering
  lastError?: string; // set when queueStatus === "failed" (dead-letter, shown in UI)
};

// What a row badge shows on top of the server-rendered status:
//   queued — a change is sitting in the outbox, not yet confirmed by the server
//   failed — the change dead-lettered (permanent error); user can discard it
//   synced — the change reached the server this session. We keep it shown (it now
//            equals server truth after router.refresh) so the badge never flickers
//            back to the stale RSC value in the window before the refresh lands.
export type StatusIndicator = "queued" | "failed" | "synced";

// The optimistic overlay the UI reads: signId → the target status + its indicator.
// Rebuilt from the persisted outbox on mount so optimistic state survives a
// reload (only pending/failed entries persist; synced ones are gone and the
// server already reflects them).
export type StatusOverlay = Record<
  number,
  { status: SignStatusValue; indicator: StatusIndicator }
>;
