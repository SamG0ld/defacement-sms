// M6 field-deployment sync contract (Phase 0 — frozen).
//
// The single source of truth for the JSON API shared by BOTH clients: the web
// PWA (cookie-authenticated) and the native iOS app (bearer-authenticated). The
// request schemas are validated server-side in the `/api/native/*` route
// handlers; the response *types* are mirrored as iOS `Codable` structs. Keep
// this file dependency-light (only zod) so it can be reasoned about in
// isolation and so the shapes never drift between server and clients.
//
// Core invariants encoded here:
//   - Every mutation carries a client-generated `clientId` so an at-least-once
//     offline replay is idempotent: the server returns the SAME result for a
//     repeated clientId (DeployEvent.clientId is @unique).
//   - Claiming is an EXCLUSIVE lock: a batch claim grants only `sorted` +
//     currently-unclaimed signs; everything else comes back in `rejected`.
//   - Deploying does NOT require holding the claim (two offline crews could both
//     deploy the same sign). The first event to reach the server sets the sign's
//     terminal `deployed` state; later/duplicate events are recorded as
//     `conflict`/`duplicate` for the deploy log but never overwrite it.

import { z } from "zod";

// ── Primitives ──────────────────────────────────────────────────────────────

// Opaque client-generated idempotency key (UUID in practice — crypto.randomUUID
// on web, UUID() on iOS). Validated loosely on purpose: it's a dedup token, not
// a trust boundary, and we must never reject a well-formed client key on a
// format technicality while a crew is offline on the floor.
export const clientId = z.string().min(8).max(128);

export const signId = z.number().int().positive();
export const crewId = z.number().int().positive();

// Batch caps: generous enough for "claim a whole zone's stack" but bounded so a
// single request can't blow the pool (lib/db.ts max:3) or the body limit.
const MAX_CLAIM_BATCH = 500;
const MAX_DEPLOY_BATCH = 200;

// ── Crews ───────────────────────────────────────────────────────────────────

export const createCrewSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateCrewInput = z.infer<typeof createCrewSchema>;

export type CrewView = {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string; // ISO 8601
  memberUserIds: string[];
};

// ── Claims (exclusive lock) ───────────────────────────────────────────────────

export const claimRequestSchema = z.object({
  clientId,
  crewId,
  signIds: z.array(signId).min(1).max(MAX_CLAIM_BATCH),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

// Why a sign in the requested batch was not granted to the crew.
//   already_claimed — held by another crew (byCrewId identifies it)
//   not_sorted      — not in the `sorted` phase (claiming is post-sort only)
//   not_found       — no such sign
export const claimRejectReasons = ["already_claimed", "not_sorted", "not_found"] as const;
export type ClaimRejectReason = (typeof claimRejectReasons)[number];

export type ClaimRejection = {
  signId: number;
  reason: ClaimRejectReason;
  byCrewId: number | null;
};

export type ClaimResponse = {
  granted: number[]; // signIds now locked to the requesting crew (idempotent)
  rejected: ClaimRejection[];
};

// `clientId` is accepted for the offline outbox to dedupe a queued release on
// replay; release is naturally idempotent server-side (releasing an unheld claim
// is a no-op), so it isn't persisted — it just lets the client clear its queue.
export const releaseRequestSchema = z.object({
  clientId,
  crewId,
  signIds: z.array(signId).min(1).max(MAX_CLAIM_BATCH),
});
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;

export type ReleaseResponse = {
  released: number[]; // signIds whose lock the crew actually held and dropped
};

// ── Deploys ───────────────────────────────────────────────────────────────────

export const deployEventSchema = z.object({
  clientId,
  signId,
  crewId: crewId.nullish(), // optional: a sign can be deployed without a crew
  deployedAt: z.coerce.date(), // client's local deploy time (ISO string in JSON)
  notes: z.string().max(2000).optional(),
  hasPhoto: z.boolean().default(false), // photo trickles up separately, after
});
export type DeployEventInput = z.infer<typeof deployEventSchema>;

export const deployRequestSchema = z.object({
  events: z.array(deployEventSchema).min(1).max(MAX_DEPLOY_BATCH),
});
export type DeployRequest = z.infer<typeof deployRequestSchema>;

// Per-event outcome:
//   applied   — this event set the sign to `deployed` (the first to arrive)
//   duplicate — same clientId already processed (idempotent replay, no-op)
//   conflict  — sign was already deployed by a different event; logged, no change
export const deployResultStatuses = ["applied", "duplicate", "conflict"] as const;
export type DeployResultStatus = (typeof deployResultStatuses)[number];

export type DeployResult = {
  clientId: string;
  signId: number;
  status: DeployResultStatus;
};

export type DeployResponse = {
  results: DeployResult[];
};

// Photo is a SEPARATE request (multipart), sent only after its deploy event is
// accepted, so a slow/absent photo never blocks the deploy. The body is the raw
// image (validated server-side via lib/image-upload). Path carries the deploy's
// clientId so the upload patches the right DeployEvent.
export type PhotoUploadResponse = {
  clientId: string;
  photoUrl: string; // app-internal, auth-gated serving URL (not a public Blob URL)
};

// ── Sync (pull) ───────────────────────────────────────────────────────────────

// A sign as the floor clients see it. Pin fields are resolved elsewhere (the map
// layer); this is the deploy-centric projection.
export type DeploySignView = {
  id: number;
  itemId: string;
  signText: string;
  status: string; // SignStatus
  zoneId: number | null;
  claimedByCrewId: number | null;
  claimedByUserId: string | null;
  claimedAt: string | null; // ISO
  deployedAt: string | null; // ISO
  deployPhotoUrl: string | null;
  updatedAt: string; // ISO — drives the delta cursor
};

// Full working set on first load / cold start.
export type BootstrapResponse = {
  serverTime: string; // ISO — clients clock-skew against this
  cursor: string; // opaque watermark (max updatedAt seen); pass to /sync/changes
  crews: CrewView[];
  myCrewIds: number[];
  signs: DeploySignView[];
};

// Incremental delta pull since a prior cursor.
export const changesQuerySchema = z.object({
  since: z.coerce.date(),
});
export type ChangesQuery = z.infer<typeof changesQuerySchema>;

// NB: the delta carries only signs, not crew membership — a join/leave during a
// long-lived session is reflected only on the next /sync/bootstrap. Fine for
// Phase A1 (crews are small and self-managed); revisit if iOS clients stay
// connected for hours.
export type ChangesResponse = {
  cursor: string;
  signs: DeploySignView[]; // signs whose updatedAt > since
};
