// Field-deployment service layer — the DB operations behind /api/native/*.
// Route handlers resolve the acting user then call these; integration tests call
// them directly with a fabricated actor (no HTTP). Pure classification lives in
// lib/deploy/resolve.ts; the wire shapes are in lib/deploy/contract.ts.

import { Prisma, type SignStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { logWarn } from "@/lib/log";
import { ARCHIVED_STATUS, stampsForStatus } from "@/app/(app)/signs/_lib";
import {
  ARCHIVED_REFUSAL_REASON,
  archivedRefusal,
  decideStatusChange,
} from "@/lib/sign-status-authz";
import { actorHoldsClaim } from "@/lib/sign-claims";
import {
  buildClaimResponse,
  classifyDeploys,
  classifySetStatus,
  deltaWindow,
} from "@/lib/deploy/resolve";
import { signDeployPhotoSrc } from "@/lib/deploy/photo";
import { deleteDeployPhoto } from "@/lib/deploy/blob";
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

// Ceiling on how many signs one sync call (bootstrap or delta) can pull through
// the max:3 pool. Defensive only — a real con's working set is a few hundred —
// but the cursor logic has to stay correct if it is ever hit, so it's shared by
// both queries and by the deltaWindow() that derives their cursor (#215).
const SYNC_PAGE_CAP = 5000;

const SIGN_VIEW_SELECT = {
  id: true,
  itemId: true,
  signText: true,
  status: true,
  zoneId: true,
  // Crews navigate by zone CODE ("LVCC-L1"), never by the FK, so the projection
  // carries it through the relation rather than making the client resolve it (#190).
  zone: { select: { zoneCode: true } },
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
  zone: { zoneCode: string } | null;
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
    zoneCode: s.zone?.zoneCode ?? null,
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
  await recordAudit({
    action: "crew.join",
    actorId: actor.userId,
    actorEmail: actor.email,
    detail: `crew #${crewId} "${crew.name}"`,
  });
  return crewView(crewId);
}

export async function leaveCrew(crewId: number, actor: ApiActor): Promise<void> {
  await prisma.crewMember.deleteMany({
    where: { crewId, userId: actor.userId },
  });
  await recordAudit({
    action: "crew.leave",
    actorId: actor.userId,
    actorEmail: actor.email,
    detail: `crew #${crewId}`,
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
// ANOTHER crew's claims (e.g. a crew left the floor without releasing). `force` is
// decided by the route from the actor's role.
//
// `force` means exactly one thing: skip the membership check. It does NOT widen
// the release to "whatever is claimed on these ids by anyone" — both paths match
// only claims held by the crew the request named. The route derives `force` from
// the actor's role alone (every lead/admin release is a forced one), so a wider
// filter here would make `crewId` decorative and let one lead's routine release
// silently drop a different crew's locked signs mid-deployment (#175).
export async function releaseSigns(
  req: ReleaseRequest,
  actor: ApiActor,
  force: boolean,
): Promise<ReleaseResponse> {
  if (!force) await assertMember(req.crewId, actor);

  const whereHeld = { id: { in: req.signIds }, claimedByCrewId: req.crewId };

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
      // Name the crew whose claims were dropped — a force-release across crews is
      // otherwise invisible in the trail after the fact (#175).
      detail: `crew #${req.crewId} released ${released.length} claim(s)`,
    });
  }
  return { released };
}

// ── Deploys ─────────────────────────────────────────────────────────────────

// Ids to attach to a per-batch warn line. Capped because a batch carries up to
// MAX_DEPLOY_BATCH (200) events and `clientId` is arbitrary client-supplied text
// (8-128 chars): an authenticated client looping refused deploys at the rate limit
// could otherwise turn one warn line into megabytes of paid log ingestion per
// minute. The count is always exact — only the sample is truncated — so a floor
// incident stays diagnosable without the log becoming the DoS.
const LOG_ID_SAMPLE = 20;
function sampleIds(events: { clientId: string; signId: number }[]) {
  const head = events.slice(0, LOG_ID_SAMPLE);
  return {
    signIds: head.map((e) => e.signId),
    clientIds: head.map((e) => e.clientId),
    ...(events.length > LOG_ID_SAMPLE
      ? { truncated: events.length - LOG_ID_SAMPLE }
      : {}),
  };
}

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

  // A soft-removed sign leaves `archived` ONLY through the dedicated,
  // history-aware Restore action — never a queued deploy event. classifyDeploys
  // can't catch this: it only asks "already deployed?", and `archived` isn't, so
  // the event lands in `toApply`. So the refusal is applied here, against the same
  // pre-tx read the classifier used.
  //
  // Deliberately `archivedRefusal()` and NOT the full `decideStatusChange`: this
  // path's frozen contract lets any active user deploy WITHOUT holding the claim
  // (two offline crews may both deploy one sign — see lib/deploy/contract.ts), and
  // the rest of that policy would refuse exactly that. The archived clause is the
  // only part of it this path is not exempt from — see the header note in
  // lib/sign-status-authz.ts.
  //
  // Refused events STAY in `toApply`: only their WRITE is skipped. That's what
  // gets them a persisted DeployEvent row below — a crew really did put a physical
  // sign up, and the after-action log shouldn't lose that just because the record
  // row was removed underneath them — and it's what makes a replay of the same
  // clientId an idempotent `duplicate` rather than an endless retry. (#268)
  //
  // This pre-read check is deliberately allowed to be stale in ONE direction: if a
  // lead RESTORES the sign in the window between the read and the write, a deploy
  // that would now be legal is still downgraded to `conflict` (we skip the write
  // rather than letting the DB decide, unlike the lost-the-race path below). That
  // fails closed — the cost is a rare spurious conflict the crew can retry, not a
  // resurrection — and the reverse direction (archived AFTER the read) is caught by
  // the `notIn` guard on the write itself.
  const archivedRefusals = toApply.filter(
    (e) => archivedRefusal(statusById.get(e.signId) ?? "") !== null,
  );
  const archivedClientIds = new Set(archivedRefusals.map((e) => e.clientId));
  if (archivedRefusals.length > 0) {
    // An EXPECTED outcome (a lead removed the sign while the crew was offline),
    // not an exception. logWarn keeps it searchable during a live floor incident
    // without paging Sentry on every routine refusal — logError would. (#77)
    logWarn("deploy.apply.archived-refused", ARCHIVED_REFUSAL_REASON, {
      actorId: actor.userId,
      refused: archivedRefusals.length,
      ...sampleIds(archivedRefusals),
    });
  }

  // Events whose batch rolled back on a unique violation — see the catch below.
  const batchAbortedClientIds = new Set<string>();

  // An event is reported `applied` only if it survived every downgrade: it wasn't
  // refused as archived, didn't lose the write-time race, and its batch didn't
  // roll back. Shared by the persisted DeployEvent row and the wire result so the
  // after-action log and the crew's screen can never disagree.
  const downgraded = (clientId: string): boolean =>
    lostClientIds.has(clientId) ||
    archivedClientIds.has(clientId) ||
    batchAbortedClientIds.has(clientId);

  try {
    await prisma.$transaction(async (tx) => {
      for (const e of toApply) {
        const oldStatus = statusById.get(e.signId);
        if (oldStatus === undefined) {
          lostClientIds.add(e.clientId); // sign deleted between read and write
          continue;
        }
        // Refused above: logged as a conflict below, never written. (#268)
        if (archivedClientIds.has(e.clientId)) continue;
        const stamps = stampsForStatus("deployed", changedBy, e.deployedAt);
        // Guard on "not already deployed" so a concurrent batch can't double-apply;
        // consume the claim lock on deploy (claimed → null). ARCHIVED_STATUS is
        // excluded too, so the read→write race is closed at the DB as well: the
        // in-memory refusal above keeps the wire result honest, THIS is the actual
        // guarantee that a tombstone can never be resurrected. (#268)
        const res = await tx.sign.updateMany({
          where: { id: e.signId, status: { notIn: ["deployed", ARCHIVED_STATUS] } },
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
          applyClientIds.has(e.clientId) && !downgraded(e.clientId)
            ? "applied"
            : "conflict",
      }));
      if (eventRows.length > 0) {
        await tx.deployEvent.createMany({ data: eventRows, skipDuplicates: true });
      }
    });
  } catch (err) {
    // A unique violation aborts the WHOLE transaction — Postgres marks it aborted,
    // so there is no per-statement recovery without savepoints — meaning nothing in
    // this batch committed. Report every event that would have applied as
    // `conflict` instead of letting the error escape: runApi maps an unhandled
    // throw to a 500, and the deploy client classifies 5xx as "stop", which leaves
    // the entry pending forever and BLOCKS every deploy queued behind it
    // (app/(app)/deploy/_lib/sync.ts). `conflict` is permanent, so the client
    // drains the entry and shows a notice and the outbox keeps moving. (#268)
    //
    // Deliberate residual, and it is a REAL cost, not a free win: the rollback
    // takes the whole batch with it — every sign update, and the DeployEvent rows
    // for the untouched `toLogConflict` events too. So a batch-mate of a poisoned
    // event is reported `conflict`, the client drains it, and NO event row survives
    // to say it was ever attempted. That is worse bookkeeping than the archived
    // path above (which does persist its row), and it is accepted only because the
    // alternative — a 500 — wedges the crew's entire outbox for the rest of the
    // con. After the archived guard above there is no known route left to a P2002
    // here, so this is the backstop for an unknown one; it must never become the
    // thing the guard relies on.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      logWarn(
        "deploy.apply.unique-violation",
        "deploy batch rolled back on a unique constraint violation",
        {
          actorId: actor.userId,
          rolledBack: toApply.length,
          ...sampleIds(toApply),
          target: err.meta?.target,
        },
      );
      for (const e of toApply) batchAbortedClientIds.add(e.clientId);
    } else {
      throw err;
    }
  }

  // Correct wire results for every event that was downgraded after classification.
  const finalResults = results.map((r) =>
    r.status === "applied" && downgraded(r.clientId)
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
      // category feeds the external-only rule for handed_off/installed (#232) —
      // this queued path shares the same policy as the online action, so the
      // offline outbox can't be used to reach a status the dropdown refuses.
      select: { status: true, category: true, claimedByCrewId: true },
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

  // H2: authorize the actual change. `sign` is non-null here (classify only
  // returns "applied" when it exists). Volunteers are forward-only and need
  // their crew's claim to mark a sign `deployed`; regressions are lead/admin.
  // A rejected queued change is echoed as `forbidden` so the offline client
  // resolves (drops) it instead of replaying it forever.
  const holdsClaim =
    req.status === "deployed"
      ? await actorHoldsClaim(actor.userId, sign!.claimedByCrewId)
      : false;
  const decision = decideStatusChange({
    role: actor.role,
    currentStatus: sign!.status,
    targetStatus: req.status,
    actorHoldsClaim: holdsClaim,
    category: sign!.category,
  });
  if (!decision.ok) {
    // A refused queued/online change is an EXPECTED outcome (backward move,
    // unclaimed deploy, wrong role) — not an exception. Emit a searchable
    // structured line so on-call can tell "refused" from "never received"
    // during a live floor incident, without paging Sentry on every routine
    // refusal (logWarn does not forward to Sentry; logError would). (#77)
    logWarn("deploy.set-status.forbidden", decision.reason, {
      actorId: actor.userId,
      signId: req.signId,
      attemptedStatus: req.status,
    });
    return { signId: req.signId, status: req.status, result: "forbidden" };
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

export type AttachDeployPhotoResult = {
  signId: number;
  // Whether the Sign's cached photo was updated too — see the status gate below.
  cachedOnSign: boolean;
};

// Patch the deploy photo (a private Blob pathname, stored server-side only) onto
// its DeployEvent and — when that event is the one that actually deployed the sign
// — cache it on the Sign for cheap list/map rendering. Called by the photo upload
// route after the Blob upload succeeds. Returns the signId plus whether the sign
// cache was written (the route picks the serving URL from that), or null if the
// clientId isn't a known event or its sign vanished mid-flight.
//
// The status gate (#231): applyDeploys can write SEVERAL DeployEvents for one sign
// — the first is `applied` (it set Sign.status=deployed), every later one is
// `conflict` (logged, changes nothing). Without the gate, a crew whose deploy lost
// the race could still upload a photo and overwrite Sign.deployPhotoUrl, so the
// sign would show a photo from a deploy that never happened — and the reclaim
// below would delete the winner's blob. So the event always gets its photo (the
// after-action log keeps every crew's field evidence) but the Sign cache is
// written only by the winner.
//
// A photo re-take (event already had one attached) reclaims the replaced blob(s)
// after the swap commits, so a retake can't orphan paid storage with no DB
// reference left to find it (#127).
export async function attachDeployPhoto(
  clientId: string,
  blobPathname: string,
): Promise<AttachDeployPhotoResult | null> {
  const event = await prisma.deployEvent.findUnique({
    where: { clientId },
    select: { id: true, signId: true, photoUrl: true, status: true },
  });
  if (!event) return null;
  const cachedOnSign = event.status === "applied";
  // DeployEvent is deliberately FK-free (no Prisma relation to Sign — see the
  // model comment), so the sign's current cached URL is a separate read. Only
  // the winner needs it (it's what the reclaim below compares against), so a
  // losing crew's upload skips the round trip entirely.
  const sign = cachedOnSign
    ? await prisma.sign.findUnique({
        where: { id: event.signId },
        select: { deployPhotoUrl: true },
      })
    : null;
  try {
    await prisma.$transaction([
      prisma.deployEvent.update({ where: { id: event.id }, data: { photoUrl: blobPathname } }),
      ...(cachedOnSign
        ? [
            prisma.sign.update({
              where: { id: event.signId },
              data: { deployPhotoUrl: blobPathname },
            }),
          ]
        : []),
    ]);
  } catch (err) {
    // The sign was hard-deleted between the read above and this write (#212). The
    // whole transaction rolled back, so nothing partial committed — report it the
    // same way as an unknown clientId and let the route turn it into the expected
    // 404 + blob cleanup instead of an unhandled 500 that pages on-call.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // Logged (not silent) so this stays distinguishable from the far more
      // common "bad clientId" 404 the route returns for it — both look identical
      // to the caller, and only this one means a sign disappeared mid-upload.
      logWarn("deploy.photo.sign-vanished", "sign deleted mid-upload", {
        clientId,
        signId: event.signId,
      });
      return null;
    }
    throw err;
  }
  // Reclaim the replaced blob(s) now that the swap is committed. event.photoUrl
  // and sign.deployPhotoUrl are usually the same pathname (the common case) —
  // dedupe via the Set so that's one delete, not two. The sign's pathname is only
  // eligible when we actually replaced it: a losing event must never reclaim the
  // winning deploy's blob (#231). Best-effort — never fails the already-successful
  // attach.
  const replaced = cachedOnSign
    ? [event.photoUrl, sign?.deployPhotoUrl]
    : [event.photoUrl];
  const oldPathnames = new Set(
    replaced.filter((p): p is string => p != null && p !== blobPathname),
  );
  for (const oldPathname of oldPathnames) {
    await deleteDeployPhoto(oldPathname);
  }
  return { signId: event.signId, cachedOnSign };
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
      // Oldest-first with an id tiebreaker so the page is deterministic if the cap
      // below ever truncates it — an arbitrary subset can't be turned into a
      // cursor that doesn't skip rows (#215).
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      // Defensive ceiling only — the real working set is a few hundred signs.
      // Bounds what one bootstrap call can pull through the max:3 pool if the
      // table ever balloons; far above any legitimate con's inventory.
      take: SYNC_PAGE_CAP,
    }),
  ]);

  const page = deltaWindow(signs.map(toSignView), SYNC_PAGE_CAP);
  warnIfCapped(page.capped, "bootstrap");
  const views = page.views;
  const cursor = page.cursor ?? snapshotAt.toISOString();

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
    // Oldest-first (index-backed by @@index([status, updatedAt])) with an id
    // tiebreaker: the cursor advances through the delta in timestamp order, so a
    // capped page is the OLDEST slice rather than an arbitrary subset (#215).
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: SYNC_PAGE_CAP, // cap matches /sync/bootstrap; prevents unbounded scans
  });
  const page = deltaWindow(signs.map(toSignView), SYNC_PAGE_CAP);
  warnIfCapped(page.capped, "changes");
  return {
    cursor: page.cursor ?? since.toISOString(),
    signs: page.views,
  };
}

// The cap is a ceiling no real con reaches, so hitting it means an assumption
// broke (much larger inventory, a widened status filter). Say so once per call —
// clients still make correct forward progress, but on-call should know the delta
// is now being served a page at a time.
function warnIfCapped(capped: boolean, source: string): void {
  if (!capped) return;
  logWarn(
    "deploy.sync.page-capped",
    `${source} hit the ${SYNC_PAGE_CAP}-sign page cap`,
    { source, cap: SYNC_PAGE_CAP },
  );
}
