import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  applyDeploys,
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
            hasPhoto: false,
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
          { clientId: "forge-1", signId: s1.id, crewId: crewA, deployedAt: new Date(), hasPhoto: false },
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
          { clientId: "real-1", signId: s2.id, crewId: crewA, deployedAt: new Date(), hasPhoto: false },
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
      hasPhoto: false,
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
        { events: [{ clientId: "z-a", signId: s.id, crewId: null, deployedAt: new Date(), hasPhoto: false }] },
        actorA,
      ),
      applyDeploys(
        { events: [{ clientId: "z-b", signId: s.id, crewId: null, deployedAt: new Date(), hasPhoto: false }] },
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
          { clientId: "dep-a", signId: s.id, crewId: null, deployedAt: new Date(), hasPhoto: false },
        ],
      },
      actorA,
    );
    const res = await applyDeploys(
      {
        events: [
          { clientId: "dep-b", signId: s.id, crewId: null, deployedAt: new Date(), hasPhoto: false },
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
    const delta = await changes(new Date(boot.cursor));
    expect(delta.signs.map((s) => s.id)).toContain(fresh.id);
  });
});
