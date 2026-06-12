// Field-deployment service layer — the DB operations behind /api/native/*.
// Route handlers resolve the acting user then call these; integration tests call
// them directly with a fabricated actor (no HTTP). Pure classification lives in
// lib/deploy/resolve.ts; the wire shapes are in lib/deploy/contract.ts.

import { Prisma, type SignStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { stampsForStatus } from "@/app/(app)/signs/_lib";
import {
  buildClaimResponse,
  classifyDeploys,
  classifySetStatus,
} from "@/lib/deploy/resolve";
import { signDeployPhotoSrc } from "@/lib/deploy/photo";
import type {
  BootstrapResponse,
  ChangesResponse,
  ClaimRequest,
  ClaimResponse,
  CreateCrewInput,
  CrewView,
  DeployRequest,
  DeployResponse,
  DeploySignView,
  ReleaseRequest,
  ReleaseResponse,
  SetSignStatusBatchInput,
  SetSignStatusBatchResponse,
  SetSignStatusInput,
  SetSignStatusResponse,
} from "@/lib/deploy/contract";
import { ApiError, type ApiActor } from "@/lib/deploy/api-types";

// The floor working set: signs a crew can act on. Claiming is post-sort, so
// claimable signs are `sorted`; `deployed` is kept so a just-deployed sign still
// shows (and its claim shows as consumed). Both clients pull this projection.
const WORKING_STATUSES: SignStatus[] = ["sorted", "deployed"];

const SIGN_VIEW_SELECT = {
  id: true,
  itemId: true,
  signText: true,
  status: true,
  zoneId: true,
  claimedByCrewId: true,
  claimedByUserId: true,
  claimedAt: true,
  deployedAt: true,
  deployPhotoUrl: true,
  updatedAt: true,
} as const;

type SignViewRow = {
  id: number;
  itemId: string;
  signText: string;
  status: SignStatus;
  zoneId: number | null;
  claimedByCrewId: number | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  deployedAt: Date | null;
  deployPhotoUrl: string | null;
  updatedAt: Date;
};

function toSignView(s: SignViewRow): DeploySignView {
  return {
    id: s.id,
    itemId: s.itemId,
    signText: s.signText,
    status: s.status,
    zoneId: s.zoneId,
    claimedByCrewId: s.claimedByCrewId,
    claimedByUserId: s.claimedByUserId,
    claimedAt: s.claimedAt?.toISOString() ?? null,
    deployedAt: s.deployedAt?.toISOString() ?? null,
    // Never expose the raw Blob reference. Clients get an auth-gated serving URL
    // that streams the private blob through our own route (see
    // app/api/native/photos/sign/[signId]).
    deployPhotoUrl: s.deployPhotoUrl ? signDeployPhotoSrc(s.id) : null,
    updatedAt: s.updatedAt.toISOString(),
  };
}

function changedByOf(actor: ApiActor): string {
  return actor.email ?? actor.userId;
}

// ── Crews ───────────────────────────────────────────────────────────────────

async function crewView(crewId: number): Promise<CrewView> {
  const crew = await prisma.crew.findUnique({
    where: { id: crewId },
    include: { members: { select: { userId: true } } },
  });
  if (!crew) throw new ApiError(404, "crew not found");
  return {
    id: crew.id,
    name: crew.name,
    isActive: crew.isActive,
    createdAt: crew.createdAt.toISOString(),
    memberUserIds: crew.members.map((m) => m.userId),
  };
}

export async function createCrew(
  input: CreateCrewInput,
  actor: ApiActor,
): Promise<CrewView> {
  const crew = await prisma.crew.create({
    data: {
      name: input.name,
      createdByUserId: actor.userId,
      members: { create: { userId: actor.userId } },
    },
  });
  await recordAudit({
    action: "crew.create",
    actorId: actor.userId,
    actorEmail: actor.email,
    detail: `crew #${crew.id} "${crew.name}"`,
  });
  return crewView(crew.id);
}

export async function joinCrew(crewId: number, actor: ApiActor): Promise<CrewView> {
  const crew = await prisma.crew.findUnique({ where: { id: crewId } });
  if (!crew || !crew.isActive) throw new ApiError(404, "crew not found");
  await prisma.crewMember.upsert({
    where: { crewId_userId: { crewId, userId: actor.userId } },
    create: { crewId, userId: actor.userId },
    update: {},
  });
  return crewView(crewId);
}

export async function leaveCrew(crewId: number, actor: ApiActor): Promise<void> {
  await prisma.crewMember.deleteMany({
    where: { crewId, userId: actor.userId },
  });
}

async function assertMember(crewId: number, actor: ApiActor): Promise<void> {
  // Independent lookups — one round-trip of latency, not two (this runs on
  // every claim/release).
  const [crew, member] = await Promise.all([
    prisma.crew.findUnique({
      where: { id: crewId },
      select: { isActive: true },
    }),
    prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId, userId: actor.userId } },
      select: { userId: true },
    }),
  ]);
  if (!crew || !crew.isActive) throw new ApiError(404, "crew not found");
  if (!member) throw new ApiError(403, "not a member of this crew");
}

// ── Claims (exclusive lock) ────────────────────────────────────────────────────

export async function claimSigns(
  req: ClaimRequest,
  actor: ApiActor,
): Promise<ClaimResponse> {
  await assertMember(req.crewId, actor);
  const now = new Date();

  // Conditional lock + read-back in one transaction so `granted` is consistent
  // with the rows we actually hold. The UPDATE only matches sorted + unclaimed
  // rows (the exclusive lock); the read-back lets us explain the rest and fold in
  // idempotent re-claims (rows already held by this crew).
  //
  // The LOCK itself is always correct: the conditional updateMany is atomic
  // per-row, so two crews can never both be granted the same sign (Postgres row
  // locks serialize the UPDATEs; only one matches `claimedByCrewId: null`). Under
  // the default READ COMMITTED isolation the read-back is best-effort *only for
  // the rejection reason* — a sign racing with another crew may be reported
  // already_claimed (byCrewId null) rather than its precise cause. That's the
  // safe direction (client retries/picks another); never a wrong grant.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.sign.updateMany({
      where: {
        id: { in: req.signIds },
        claimedByCrewId: null,
        status: "sorted",
      },
      data: {
        claimedByCrewId: req.crewId,
        claimedByUserId: actor.userId,
        claimedAt: now,
      },
    });
    return tx.sign.findMany({
      where: { id: { in: req.signIds } },
      select: { id: true, status: true, claimedByCrewId: true },
    });
  });

  const stateById = new Map(
    rows.map((r) => [r.id, { status: r.status as string, claimedByCrewId: r.claimedByCrewId }]),
  );
  const grantedNow = rows
    .filter((r) => r.claimedByCrewId === req.crewId)
    .map((r) => r.id);

  const response = buildClaimResponse(req.signIds, req.crewId, grantedNow, stateById);

  if (response.granted.length > 0) {
    await recordAudit({
      action: "deploy.claim",
      actorId: actor.userId,
      actorEmail: actor.email,
      detail: `crew #${req.crewId} claimed ${response.granted.length} sign(s)`,
    });
  }
  return response;
}

// Release a lock. A crew releases its own claims; lead+/admin may force-release
// any claim (e.g. a crew left the floor without releasing). `force` is decided by
// the route from the actor's role.
export async function releaseSigns(
  req: ReleaseRequest,
  actor: ApiActor,
  force: boolean,
): Promise<ReleaseResponse> {
  if (!force) await assertMember(req.crewId, actor);

  const whereHeld = force
    ? { id: { in: req.signIds }, claimedByCrewId: { not: null } }
    : { id: { in: req.signIds }, claimedByCrewId: req.crewId };

  const released = await prisma.$transaction(async (tx) => {
    const held = await tx.sign.findMany({
      where: whereHeld,
      select: { id: true },
    });
    const ids = held.map((h) => h.id);
    if (ids.length > 0) {
      await tx.sign.updateMany({
        where: { id: { in: ids } },
        data: { claimedByCrewId: null, claimedByUserId: null, claimedAt: null },
      });
    }
    return ids;
  });

  if (released.length > 0) {
    await recordAudit({
      action: force ? "deploy.release_force" : "deploy.release",
      actorId: actor.userId,
      actorEmail: actor.email,
      detail: `released ${released.length} claim(s)`,
    });
  }
  return { released };
}

// ── Deploys ─────────────────────────────────────────────────────────────────

export async function applyDeploys(
  req: DeployRequest,
  actor: ApiActor,
): Promise<DeployResponse> {
  const events = req.events;
  const clientIds = events.map((e) => e.clientId);
  const signIds = [...new Set(events.map((e) => e.signId))];
  // crewId is client-supplied attribution. Verify the actor actually belongs to
  // every crew they attribute a deploy to (AR-1) so the after-action log can't
  // be stamped with someone else's crew label — batched into one query.
  const crewIds = [
    ...new Set(
      events.map((e) => e.crewId).filter((c): c is number => c != null),
    ),
  ];

  // Reads outside the transaction; idempotency (clientId @unique) + the
  // status-guarded update inside the tx make the classify→write safe under
  // concurrent identical batches.
  const [existing, signRows, memberships] = await Promise.all([
    prisma.deployEvent.findMany({
      where: { clientId: { in: clientIds } },
      select: { clientId: true },
    }),
    prisma.sign.findMany({
      where: { id: { in: signIds } },
      select: { id: true, status: true },
    }),
    crewIds.length > 0
      ? prisma.crewMember.findMany({
          where: { userId: actor.userId, crewId: { in: crewIds } },
          select: { crewId: true },
        })
      : Promise.resolve([]),
  ]);

  const existingClientIds = new Set(existing.map((e) => e.clientId));
  // Crews the actor is a verified member of. An unverified crewId is dropped to
  // null when the event is persisted (below) — the deploy still lands, so a
  // stale/forged label degrades availability-safely instead of blocking a
  // floor deploy.
  const memberCrewIds = new Set(memberships.map((m) => m.crewId));
  const statusById = new Map(signRows.map((s) => [s.id, s.status as string]));
  const deployedSignIds = new Set(
    signRows.filter((s) => s.status === "deployed").map((s) => s.id),
  );

  const { toApply, toLogConflict, applyClientIds, results } = classifyDeploys(
    events,
    existingClientIds,
    deployedSignIds,
  );

  const changedBy = changedByOf(actor);
  // Events classified `applied` from the pre-tx read but whose guarded write
  // matched 0 rows — a concurrent batch deployed the sign first, or it was
  // deleted. They lost the race, so we downgrade their log row + wire result to
  // `conflict` for an honest after-action record (idempotency on clientId is
  // still sound; only the label is corrected).
  const lostClientIds = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const e of toApply) {
      const oldStatus = statusById.get(e.signId);
      if (oldStatus === undefined) {
        lostClientIds.add(e.clientId); // sign deleted between read and write
        continue;
      }
      const stamps = stampsForStatus("deployed", changedBy, e.deployedAt);
      // Guard on "not already deployed" so a concurrent batch can't double-apply;
      // consume the claim lock on deploy (claimed → null).
      const res = await tx.sign.updateMany({
        where: { id: e.signId, status: { not: "deployed" } },
        data: {
          status: "deployed",
          ...stamps,
          claimedByCrewId: null,
          claimedByUserId: null,
          claimedAt: null,
        },
      });
      if (res.count === 0) {
        lostClientIds.add(e.clientId); // lost the race — already deployed
        continue;
      }
      await tx.statusHistory.create({
        data: {
          signId: e.signId,
          oldStatus,
          newStatus: "deployed",
          changedBy,
          notes: e.notes ?? null,
        },
      });
    }

    const eventRows = [...toApply, ...toLogConflict].map((e) => ({
      clientId: e.clientId,
      signId: e.signId,
      // crewId is advisory attribution for the after-action log. Persist it
      // only when the actor is a verified member of that crew (AR-1); an
      // unverified/forged label is dropped to null rather than blocking the
      // deploy.
      crewId: e.crewId != null && memberCrewIds.has(e.crewId) ? e.crewId : null,
      deployedByUserId: actor.userId,
      deployedByEmail: actor.email,
      deployedAt: e.deployedAt,
      notes: e.notes ?? null,
      photoUrl: null,
      status:
        applyClientIds.has(e.clientId) && !lostClientIds.has(e.clientId)
          ? "applied"
          : "conflict",
    }));
    if (eventRows.length > 0) {
      await tx.deployEvent.createMany({ data: eventRows, skipDuplicates: true });
    }
  });

  // Correct wire results for the events that lost the write-time race.
  const finalResults =
    lostClientIds.size === 0
      ? results
      : results.map((r) =>
          r.status === "applied" && lostClientIds.has(r.clientId)
            ? { ...r, status: "conflict" as const }
            : r,
        );

  const appliedCount = finalResults.filter((r) => r.status === "applied").length;
  if (appliedCount > 0) {
    await recordAudit({
      action: "deploy.batch",
      actorId: actor.userId,
      actorEmail: actor.email,
      detail: `deployed ${appliedCount} sign(s)`,
    });
  }
  return { results: finalResults };
}

// ── Sign status (single offline-queued change) ────────────────────────────────

// Apply ONE per-sign status change, idempotent on clientId — the queued
// counterpart to the online updateSignStatus Server Action. Mirrors the
// applyDeploys discipline: reads outside the transaction, then a guarded write
// whose unique clientId makes an at-least-once replay exactly-once. Last writer
// wins for DIFFERENT clientIds touching the same sign (status is IDOR-by-design;
// StatusHistory keeps the audited trail) — there is no status guard.
export async function setSignStatus(
  req: SetSignStatusInput,
  actor: ApiActor,
): Promise<SetSignStatusResponse> {
  const changedBy = changedByOf(actor);

  // Reads outside the transaction; the unique clientId + the P2002 catch inside
  // the write make the classify→write safe under a concurrent identical replay.
  const [existing, sign] = await Promise.all([
    prisma.statusHistory.findUnique({
      where: { clientId: req.clientId },
      select: { id: true },
    }),
    prisma.sign.findUnique({
      where: { id: req.signId },
      select: { status: true },
    }),
  ]);

  const result = classifySetStatus({
    alreadyProcessed: existing !== null,
    currentStatus: sign?.status,
    targetStatus: req.status,
  });

  // duplicate / not_found / noop all write nothing — there's no ledger row to
  // add (a no-op has nothing to replay; a duplicate already has its row).
  if (result !== "applied") {
    return { signId: req.signId, status: req.status, result };
  }

  // `sign` is non-null here: classify only returns "applied" when the sign
  // exists and its status differs from the target.
  // Known last-writer-wins limitation (matches applyDeploys' pre-tx read): the
  // status read happened outside the transaction, so if a concurrent writer
  // changes the sign between the read and the write below, this update silently
  // overwrites it and the history row records the `oldStatus` THIS thread read,
  // which may be stale. That's inherent to the no-locking IDOR-by-design model;
  // the audited trail still captures every change, just possibly with a stale
  // from-status in the rare race window.
  const oldStatus = sign!.status;
  const stamps = stampsForStatus(req.status, changedBy, req.changedAt);

  try {
    await prisma.$transaction([
      prisma.sign.update({
        where: { id: req.signId },
        data: { status: req.status, ...stamps },
      }),
      prisma.statusHistory.create({
        data: {
          signId: req.signId,
          clientId: req.clientId,
          oldStatus,
          newStatus: req.status,
          changedBy,
          changedAt: req.changedAt,
          notes: req.notes ?? null,
        },
      }),
    ]);
  } catch (err) {
    // A concurrent replay of the SAME clientId won the race and already wrote the
    // history row (unique violation) — the whole transaction (incl. the sign
    // update) rolled back, so reporting `duplicate` is honest idempotency.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { signId: req.signId, status: req.status, result: "duplicate" };
    }
    throw err;
  }

  // Best-effort audit (recordAudit swallows its own failures).
  await recordAudit({
    action: "sign.status",
    actorId: actor.userId,
    actorEmail: actor.email,
    detail: `sign #${req.signId} ${oldStatus} → ${req.status}`,
  });

  return { signId: req.signId, status: req.status, result: "applied" };
}

// Batch counterpart to setSignStatus for the offline-queue drain: applies the
// changes sequentially (the queue is FIFO — order matters under
// last-writer-wins) and echoes per-change results keyed by clientId. Each
// change keeps setSignStatus's own idempotency/transaction semantics.
export async function setSignStatusBatch(
  req: SetSignStatusBatchInput,
  actor: ApiActor,
): Promise<SetSignStatusBatchResponse> {
  const results: SetSignStatusBatchResponse["results"] = [];
  for (const change of req.changes) {
    const result = await setSignStatus(change, actor);
    results.push({ clientId: change.clientId, ...result });
  }
  return { results };
}

// Patch the deploy photo (a private Blob pathname, stored server-side only) onto
// its DeployEvent + cache it on the Sign for cheap list/map rendering. Called by
// the photo upload route after the Blob upload succeeds. Returns the signId so
// the route can build the gated serving URL, or null if the clientId isn't a
// known event.
export async function attachDeployPhoto(
  clientId: string,
  blobPathname: string,
): Promise<number | null> {
  const event = await prisma.deployEvent.findUnique({
    where: { clientId },
    select: { id: true, signId: true },
  });
  if (!event) return null;
  await prisma.$transaction([
    prisma.deployEvent.update({ where: { id: event.id }, data: { photoUrl: blobPathname } }),
    prisma.sign.update({
      where: { id: event.signId },
      data: { deployPhotoUrl: blobPathname },
    }),
  ]);
  return event.signId;
}

// ── Sync (pull) ───────────────────────────────────────────────────────────────

export async function bootstrap(actor: ApiActor): Promise<BootstrapResponse> {
  // Stamp the snapshot time BEFORE the queries so the cursor never skips a sign
  // updated during the query window — a subsequent /sync/changes?since=<cursor>
  // will catch anything with updatedAt >= this instant.
  const snapshotAt = new Date();
  const [crews, myMemberships, signs] = await Promise.all([
    prisma.crew.findMany({
      where: { isActive: true },
      include: { members: { select: { userId: true } } },
      orderBy: { id: "asc" },
    }),
    prisma.crewMember.findMany({
      where: { userId: actor.userId },
      select: { crewId: true },
    }),
    prisma.sign.findMany({
      where: { status: { in: WORKING_STATUSES } },
      select: SIGN_VIEW_SELECT,
      // Defensive ceiling only — the real working set is a few hundred signs.
      // Bounds what one bootstrap call can pull through the max:3 pool if the
      // table ever balloons; far above any legitimate con's inventory.
      take: 5000,
    }),
  ]);

  const views = signs.map(toSignView);
  const cursor = maxUpdatedAt(views) ?? snapshotAt.toISOString();

  return {
    serverTime: snapshotAt.toISOString(),
    cursor,
    crews: crews.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      createdAt: c.createdAt.toISOString(),
      memberUserIds: c.members.map((m) => m.userId),
    })),
    myCrewIds: myMemberships.map((m) => m.crewId),
    signs: views,
  };
}

export async function changes(since: Date): Promise<ChangesResponse> {
  // Known limitation: the WORKING_STATUSES filter means a sign that *leaves* the
  // working set (e.g. an admin rolls `sorted` back to `delivered`) won't appear
  // here, so a long-connected client could keep showing it as claimable. A
  // periodic /sync/bootstrap re-sync reconciles this; acceptable given rollbacks
  // are rare admin actions. (If it bites, drop the status filter here and let the
  // client decide visibility, or emit tombstones.)
  const signs = await prisma.sign.findMany({
    where: { status: { in: WORKING_STATUSES }, updatedAt: { gt: since } },
    select: SIGN_VIEW_SELECT,
  });
  const views = signs.map(toSignView);
  return {
    cursor: maxUpdatedAt(views) ?? since.toISOString(),
    signs: views,
  };
}

function maxUpdatedAt(views: DeploySignView[]): string | null {
  let max: string | null = null;
  for (const v of views) {
    if (max === null || v.updatedAt > max) max = v.updatedAt;
  }
  return max;
}
