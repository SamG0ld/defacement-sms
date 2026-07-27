import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  applyDeploys,
  attachDeployPhoto,
  bootstrap,
  changes,
  claimSigns,
  createCrew,
  joinCrew,
  releaseSigns,
} from "@/lib/deploy/service";
import type { ApiActor } from "@/lib/deploy/api-types";

const actorA: ApiActor = { userId: "uA", email: "a@example.com", role: "volunteer" };
const actorB: ApiActor = { userId: "uB", email: "b@example.com", role: "volunteer" };
const lead: ApiActor = { userId: "uL", email: "lead@example.com", role: "lead" };

let seq = 0;
beforeEach(() => {
  seq = 0; // reset so seeded ids never depend on prior tests' run order (#63)
});
function seedSign(status = "sorted") {
  seq += 1;
  return prisma.sign.create({
    data: {
      itemId: `D-${seq}`,
      signText: `Sign ${seq}`,
      signType: "Sign",
      size: "22x28",
      status: status as never,
    },
  });
}

async function crewFor(actor: ApiActor, name: string) {
  const crew = await createCrew({ name }, actor);
  return crew.id;
}

describe("crews", () => {
  it("creates a crew with the creator as first member", async () => {
    const crew = await createCrew({ name: "Alpha" }, actorA);
    expect(crew.name).toBe("Alpha");
    expect(crew.memberUserIds).toEqual(["uA"]);
  });

  it("join is idempotent (no duplicate membership)", async () => {
    const id = await crewFor(actorA, "Alpha");
    await joinCrew(id, actorB);
    const again = await joinCrew(id, actorB);
    expect(again.memberUserIds.sort()).toEqual(["uA", "uB"]);
  });
});

describe("claimSigns — exclusive lock", () => {
  it("grants sorted+unclaimed signs to the crew", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s1 = await seedSign();
    const s2 = await seedSign();
    const res = await claimSigns(
      { clientId: "c-claim-1", crewId, signIds: [s1.id, s2.id] },
      actorA,
    );
    expect(res.granted.sort()).toEqual([s1.id, s2.id].sort());
    expect(res.rejected).toEqual([]);
    const locked = await prisma.sign.findUnique({ where: { id: s1.id } });
    expect(locked?.claimedByCrewId).toBe(crewId);
    expect(locked?.claimedByUserId).toBe("uA");
  });

  it("rejects a non-sorted sign as not_sorted", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s = await seedSign("delivered");
    const res = await claimSigns(
      { clientId: "c-claim-2", crewId, signIds: [s.id] },
      actorA,
    );
    expect(res.granted).toEqual([]);
    expect(res.rejected).toEqual([
      { signId: s.id, reason: "not_sorted", byCrewId: null },
    ]);
  });

  it("re-claim by the same crew is idempotent (granted again)", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await claimSigns({ clientId: "c1", crewId, signIds: [s.id] }, actorA);
    const again = await claimSigns({ clientId: "c2", crewId, signIds: [s.id] }, actorA);
    expect(again.granted).toEqual([s.id]);
  });

  it("only one crew wins a contested sign under concurrent claims", async () => {
    const crewA = await crewFor(actorA, "Alpha");
    const crewB = await crewFor(actorB, "Bravo");
    const s = await seedSign();
    const [resA, resB] = await Promise.all([
      claimSigns({ clientId: "ca", crewId: crewA, signIds: [s.id] }, actorA),
      claimSigns({ clientId: "cb", crewId: crewB, signIds: [s.id] }, actorB),
    ]);
    const grantedToA = resA.granted.includes(s.id);
    const grantedToB = resB.granted.includes(s.id);
    // Exactly one crew got it.
    expect(grantedToA).not.toBe(grantedToB);
    const winner = grantedToA ? crewA : crewB;
    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.claimedByCrewId).toBe(winner);
  });

  it("blocks claiming for a crew the actor isn't a member of", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await expect(
      claimSigns({ clientId: "cx", crewId, signIds: [s.id] }, actorB),
    ).rejects.toThrow(/not a member/);
  });
});

describe("releaseSigns", () => {
  it("a crew releases its own claim", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await claimSigns({ clientId: "c1", crewId, signIds: [s.id] }, actorA);
    const res = await releaseSigns(
      { clientId: "r1", crewId, signIds: [s.id] },
      actorA,
      false,
    );
    expect(res.released).toEqual([s.id]);
    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.claimedByCrewId).toBeNull();
  });

  it("a lead force-releases another crew's claim", async () => {
    const crewA = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await claimSigns({ clientId: "c1", crewId: crewA, signIds: [s.id] }, actorA);
    // lead isn't a member of crewA but force-releases.
    const res = await releaseSigns(
      { clientId: "r1", crewId: crewA, signIds: [s.id] },
      lead,
      true,
    );
    expect(res.released).toEqual([s.id]);
  });

  // #175: `force` means "skip the membership check", NOT "release whatever is
  // claimed on these ids by anyone". A signIds list spanning two crews (stale
  // client state, copy-pasted ids) must only drop the crew the request named —
  // otherwise a routine lead force-release silently steals another crew's locked
  // signs mid-deployment, with nothing in the audit trail to show it.
  it("force-release honors the requested crewId and leaves another crew's claim alone", async () => {
    const crewA = await crewFor(actorA, "Alpha");
    const crewB = await crewFor(actorB, "Bravo");
    const sA = await seedSign();
    const sB = await seedSign();
    await claimSigns({ clientId: "c1", crewId: crewA, signIds: [sA.id] }, actorA);
    await claimSigns({ clientId: "c2", crewId: crewB, signIds: [sB.id] }, actorB);

    const res = await releaseSigns(
      { clientId: "r1", crewId: crewA, signIds: [sA.id, sB.id] },
      lead,
      true,
    );

    expect(res.released).toEqual([sA.id]);
    const rowB = await prisma.sign.findUnique({ where: { id: sB.id } });
    expect(rowB?.claimedByCrewId).toBe(crewB);
  });

  it("records the targeted crew in the force-release audit detail", async () => {
    const crewA = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await claimSigns({ clientId: "c1", crewId: crewA, signIds: [s.id] }, actorA);
    await releaseSigns(
      { clientId: "r1", crewId: crewA, signIds: [s.id] },
      lead,
      true,
    );
    const entry = await prisma.auditLog.findFirst({
      where: { action: "deploy.release_force" },
      orderBy: { id: "desc" },
    });
    expect(entry?.detail).toContain(`crew #${crewA}`);
  });
});

describe("applyDeploys — idempotency + conflict", () => {
  it("deploys a sign: status, stamps, claim consumed, history + event written", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const s = await seedSign();
    await claimSigns({ clientId: "c1", crewId, signIds: [s.id] }, actorA);

    const res = await applyDeploys(
      {
        events: [
          {
            clientId: "dep-1",
            signId: s.id,
            crewId,
            deployedAt: new Date(),
          },
        ],
      },
      actorA,
    );
    expect(res.results).toEqual([
      { clientId: "dep-1", signId: s.id, status: "applied" },
    ]);

    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("deployed");
    expect(row?.deployedBy).toBe("a@example.com");
    expect(row?.deployedAt).not.toBeNull();
    expect(row?.claimedByCrewId).toBeNull(); // lock consumed

    const events = await prisma.deployEvent.findMany({ where: { signId: s.id } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("applied");

    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history.some((h) => h.newStatus === "deployed")).toBe(true);
  });

  it("strips a crewId the deployer isn't a member of, but still lands the deploy (AR-1)", async () => {
    const crewA = await crewFor(actorA, "Alpha"); // actorA is a member, actorB is not
    const s1 = await seedSign();
    const s2 = await seedSign();

    // actorB forges crewA's label — the deploy applies, but the label is dropped.
    const forgedRes = await applyDeploys(
      {
        events: [
          { clientId: "forge-1", signId: s1.id, crewId: crewA, deployedAt: new Date()},
        ],
      },
      actorB,
    );
    expect(forgedRes.results[0].status).toBe("applied");
    const forged = await prisma.deployEvent.findUnique({ where: { clientId: "forge-1" } });
    expect(forged?.crewId).toBeNull(); // forged attribution stripped
    expect(forged?.deployedByEmail).toBe("b@example.com"); // true actor still recorded

    // A real member's crewId is preserved.
    const realRes = await applyDeploys(
      {
        events: [
          { clientId: "real-1", signId: s2.id, crewId: crewA, deployedAt: new Date()},
        ],
      },
      actorA,
    );
    expect(realRes.results[0].status).toBe("applied");
    const real = await prisma.deployEvent.findUnique({ where: { clientId: "real-1" } });
    expect(real?.crewId).toBe(crewA); // member's label kept
  });

  it("replaying the same clientId is a no-op duplicate", async () => {
    const s = await seedSign();
    const ev = {
      clientId: "dep-dup",
      signId: s.id,
      crewId: null,
      deployedAt: new Date(),
    };
    await applyDeploys({ events: [ev] }, actorA);
    const second = await applyDeploys({ events: [ev] }, actorA);
    expect(second.results[0].status).toBe("duplicate");
    const events = await prisma.deployEvent.findMany({ where: { signId: s.id } });
    expect(events).toHaveLength(1); // not double-inserted
  });

  it("concurrent deploys of the same sign: exactly one applied, the other conflict", async () => {
    const s = await seedSign();
    const [rA, rB] = await Promise.all([
      applyDeploys(
        { events: [{ clientId: "z-a", signId: s.id, crewId: null, deployedAt: new Date()}] },
        actorA,
      ),
      applyDeploys(
        { events: [{ clientId: "z-b", signId: s.id, crewId: null, deployedAt: new Date()}] },
        actorB,
      ),
    ]);
    // The loser must report conflict, not a dishonest "applied" (the M2 fix).
    expect([rA.results[0].status, rB.results[0].status].sort()).toEqual([
      "applied",
      "conflict",
    ]);
    const events = await prisma.deployEvent.findMany({ where: { signId: s.id } });
    expect(events.map((e) => e.status).sort()).toEqual(["applied", "conflict"]);
  });

  it("deploying an already-deployed sign is logged as a conflict, not applied", async () => {
    const s = await seedSign();
    await applyDeploys(
      {
        events: [
          { clientId: "dep-a", signId: s.id, crewId: null, deployedAt: new Date()},
        ],
      },
      actorA,
    );
    const res = await applyDeploys(
      {
        events: [
          { clientId: "dep-b", signId: s.id, crewId: null, deployedAt: new Date()},
        ],
      },
      actorB,
    );
    expect(res.results[0].status).toBe("conflict");
    const events = await prisma.deployEvent.findMany({
      where: { signId: s.id },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.status)).toEqual(["applied", "conflict"]);
    // The first deployer's stamp is preserved (conflict didn't overwrite).
    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.deployedBy).toBe("a@example.com");
  });
});

// #268: a queued deploy event must never resurrect a soft-removed sign. The old
// write guard was `status: { not: "deployed" }`, which `archived` satisfies — so a
// crew's offline outbox could move a tombstone back to `deployed`, producing a live
// duplicate that Restore can no longer recover (bulkRestore only matches rows still
// `archived`). Refusals come back as `conflict` because that is the one permanent
// result the deploy client drains (app/(app)/deploy/_lib/sync.ts) — anything the
// client treats as transient would retry forever.
describe("applyDeploys — archived signs are never resurrected (#268)", () => {
  // A soft-removed sign carrying sheet identity, as remove-actions.ts leaves it.
  function seedTombstone(itemId: string, sheetName: string, status = "archived") {
    return prisma.sign.create({
      data: {
        itemId,
        sheetName,
        signText: `${sheetName} sign`,
        signType: "Sign",
        size: "22x28",
        status: status as never,
        // Both flags matter: the #263 partial unique index is scoped to
        // `is_test_data = false AND sheet_name IS NOT NULL AND status <> 'archived'`,
        // so a fixture-flagged or sheet-nameless row would sit outside it and the
        // collision this file exists to pin would never fire.
        isTestData: false,
      },
    });
  }

  it("refuses a deploy event against an archived sign and leaves it archived", async () => {
    const s = await seedSign("archived");

    const res = await applyDeploys(
      {
        events: [
          { clientId: "arch-1", signId: s.id, crewId: null, deployedAt: new Date() },
        ],
      },
      actorA,
    );

    expect(res.results).toEqual([
      { clientId: "arch-1", signId: s.id, status: "conflict" },
    ]);

    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("archived"); // NOT resurrected
    expect(row?.deployedAt).toBeNull();
    expect(row?.deployedBy).toBeNull();

    // No history row: nothing changed, so there is no archived → deployed edge to
    // record. A written row here would be the resurrection itself.
    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(0);

    // The attempt IS still logged — a crew physically deployed something, and the
    // after-action record shouldn't lose that just because the row was removed
    // underneath them. It also makes the clientId idempotent on replay.
    const ev = await prisma.deployEvent.findUnique({ where: { clientId: "arch-1" } });
    expect(ev?.status).toBe("conflict");
    expect(ev?.deployedByEmail).toBe("a@example.com");
  });

  it("one archived event does not poison the innocent events in the same batch", async () => {
    const dead = await seedSign("archived");
    const live1 = await seedSign();
    const live2 = await seedSign();

    const res = await applyDeploys(
      {
        events: [
          { clientId: "mix-1", signId: live1.id, crewId: null, deployedAt: new Date() },
          { clientId: "mix-bad", signId: dead.id, crewId: null, deployedAt: new Date() },
          { clientId: "mix-2", signId: live2.id, crewId: null, deployedAt: new Date() },
        ],
      },
      actorA,
    );

    expect(res.results.map((r) => r.status)).toEqual([
      "applied",
      "conflict",
      "applied",
    ]);

    const rows = await prisma.sign.findMany({
      where: { id: { in: [dead.id, live1.id, live2.id] } },
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    });
    expect(rows).toEqual([
      { id: dead.id, status: "archived" },
      { id: live1.id, status: "deployed" },
      { id: live2.id, status: "deployed" },
    ]);
  });

  // The outbox-wedge regression. Remove → re-add leaves an archived tombstone whose
  // sheet identity a NEW live row now holds. A queued event still targets the
  // tombstone; resurrecting it would move it INTO the #263 partial unique index and
  // raise P2002 — which, uncaught, escapes as a 500. The deploy client classifies
  // 5xx as "stop" and BREAKS the drain, so the entry never dead-letters and every
  // deploy queued behind it is blocked for the rest of the con. Must be a conflict.
  it("a tombstone whose sheet identity a live twin now holds is a conflict, not a 500", async () => {
    const tombstone = await seedTombstone("SHEET-268", "Track 1 — W301");
    // The re-add: same (item_id, sheet_name, category) — a different row, live.
    const twin = await seedTombstone("SHEET-268", "Track 1 — W301", "sorted");

    const res = await applyDeploys(
      {
        events: [
          {
            clientId: "wedge-1",
            signId: tombstone.id,
            crewId: null,
            deployedAt: new Date(),
          },
        ],
      },
      actorA,
    );

    expect(res.results[0].status).toBe("conflict");

    const dead = await prisma.sign.findUnique({ where: { id: tombstone.id } });
    expect(dead?.status).toBe("archived");
    const live = await prisma.sign.findUnique({ where: { id: twin.id } });
    expect(live?.status).toBe("sorted"); // the live twin is untouched
  });

  it("replaying a refused clientId is idempotent and still never resurrects", async () => {
    const s = await seedSign("archived");
    const ev = {
      clientId: "arch-replay",
      signId: s.id,
      crewId: null,
      deployedAt: new Date(),
    };

    const first = await applyDeploys({ events: [ev] }, actorA);
    expect(first.results[0].status).toBe("conflict");

    // The refusal wrote its DeployEvent row, so the replay is recognised as an
    // already-processed clientId — `duplicate`, the same idempotency answer any
    // replayed deploy gets. Like `conflict` it is permanent, so the client drains
    // the entry instead of retrying it forever.
    const second = await applyDeploys({ events: [ev] }, actorA);
    expect(second.results[0].status).toBe("duplicate");

    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("archived");
    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(0);
    const events = await prisma.deployEvent.findMany({ where: { signId: s.id } });
    expect(events).toHaveLength(1); // not double-inserted
  });
});

describe("sync bootstrap + changes", () => {
  it("bootstrap returns active crews, my crews, working-set signs, and a cursor", async () => {
    const crewId = await crewFor(actorA, "Alpha");
    const sorted = await seedSign("sorted");
    await seedSign("delivered"); // not in the working set

    const boot = await bootstrap(actorA);
    expect(boot.myCrewIds).toContain(crewId);
    expect(boot.crews.some((c) => c.id === crewId)).toBe(true);
    const ids = boot.signs.map((s) => s.id);
    expect(ids).toContain(sorted.id);
    expect(boot.signs.every((s) => s.status === "sorted" || s.status === "deployed")).toBe(true);
    expect(typeof boot.cursor).toBe("string");
  });

  it("changes returns signs updated since the cursor", async () => {
    await seedSign("sorted");
    const boot = await bootstrap(actorA);
    const fresh = await seedSign("sorted"); // created after the cursor
    // changes() filters `updatedAt > since` and Prisma maps DateTime to
    // timestamp(3), so if this seed lands in the SAME millisecond as the cursor
    // the row is excluded and the assertion flips. Push it forward explicitly so
    // the test proves the delta contract instead of racing the clock (#63). Raw
    // SQL because Prisma's @updatedAt owns that column on any client-side write.
    await prisma.$executeRaw`UPDATE signs SET updated_at = updated_at + interval '1 second' WHERE id = ${fresh.id}`;
    const delta = await changes(new Date(boot.cursor));
    expect(delta.signs.map((s) => s.id)).toContain(fresh.id);
  });

  // #190: the floor projection carried only the zone FK, so /deploy rendered
  // "Zone 14". The wire contract now carries the zone's code too.
  it("the sign projection carries the zone's code, not just its id", async () => {
    // Zones are seeded reference data that setup.ts deliberately does NOT
    // truncate, so reuse one rather than inserting (zoneCode is @unique — a
    // fresh insert here would pass once and then collide on every rerun).
    const zone = await prisma.zone.findUniqueOrThrow({
      where: { zoneCode: "LVCC-L2" },
    });
    const zoned = await prisma.sign.create({
      data: {
        itemId: "ZONED-1",
        signText: "Zoned sign",
        signType: "Sign",
        size: "22x28",
        status: "sorted",
        zoneId: zone.id,
      },
    });

    const boot = await bootstrap(actorA);
    const view = boot.signs.find((s) => s.id === zoned.id);
    expect(view?.zoneId).toBe(zone.id);
    expect(view?.zoneCode).toBe("LVCC-L2");
  });

  it("an unzoned sign carries a null zone code", async () => {
    const unzoned = await seedSign("sorted");
    const boot = await bootstrap(actorA);
    const view = boot.signs.find((s) => s.id === unzoned.id);
    expect(view?.zoneId).toBeNull();
    expect(view?.zoneCode).toBeNull();
  });
});

// #231: applyDeploys writes one `applied` event (the winner, which set the sign
// to deployed) plus a `conflict` event per losing race. Against the real DB,
// prove the loser's photo can't become the sign's cached photo.
describe("attachDeployPhoto — conflict events don't clobber the Sign (#231)", () => {
  it("a conflict event's photo lands on the event only; the sign keeps the winner's", async () => {
    const s = await seedSign();
    const res = await applyDeploys(
      {
        events: [
          { clientId: "win", signId: s.id, deployedAt: new Date() },
          { clientId: "lose", signId: s.id, deployedAt: new Date() },
        ],
      },
      actorA,
    );
    expect(res.results.map((r) => r.status)).toEqual(["applied", "conflict"]);

    const winner = await attachDeployPhoto("win", "deploy-photos/winner.png");
    expect(winner).toEqual({ signId: s.id, cachedOnSign: true });

    const loser = await attachDeployPhoto("lose", "deploy-photos/loser.png");
    expect(loser).toEqual({ signId: s.id, cachedOnSign: false });

    // The loser's photo is preserved for the after-action log...
    const loseEvent = await prisma.deployEvent.findUnique({
      where: { clientId: "lose" },
      select: { photoUrl: true },
    });
    expect(loseEvent?.photoUrl).toBe("deploy-photos/loser.png");
    // ...but the sign still shows the deploy that actually won.
    const sign = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(sign?.deployPhotoUrl).toBe("deploy-photos/winner.png");
  });

  it("returns null for an unknown clientId", async () => {
    expect(await attachDeployPhoto("nope-nope-nope", "deploy-photos/x.png")).toBeNull();
  });
});
