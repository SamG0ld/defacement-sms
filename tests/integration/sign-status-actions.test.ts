import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { setSignStatus } from "@/lib/deploy/service";
import type { ApiActor } from "@/lib/deploy/api-types";

const actorA: ApiActor = { userId: "uA", email: "a@example.com", role: "volunteer" };
const actorB: ApiActor = { userId: "uB", email: "b@example.com", role: "volunteer" };

let seq = 0;
function seedSign(status = "sorted") {
  seq += 1;
  return prisma.sign.create({
    data: {
      itemId: `SS-${seq}`,
      signText: `Sign ${seq}`,
      signType: "Sign",
      size: "22x28",
      status: status as never,
    },
  });
}

describe("setSignStatus — single offline-queued status change", () => {
  it("jump-to-any applies: status, stamps, and a clientId-bearing history row", async () => {
    const s = await seedSign("pending");
    const changedAt = new Date("2026-08-07T18:00:00.000Z");
    const res = await setSignStatus(
      { clientId: "cs-apply-1", signId: s.id, status: "deployed", changedAt },
      actorA,
    );
    expect(res).toEqual({ signId: s.id, status: "deployed", result: "applied" });

    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("deployed");
    // stampsForStatus stamps deployed (with who + when = the client's changedAt).
    expect(row?.deployedBy).toBe("a@example.com");
    expect(row?.deployedAt?.toISOString()).toBe(changedAt.toISOString());

    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      clientId: "cs-apply-1",
      oldStatus: "pending",
      newStatus: "deployed",
      changedBy: "a@example.com",
    });
    expect(history[0].changedAt.toISOString()).toBe(changedAt.toISOString());
  });

  it("persists an optional note on the history row", async () => {
    const s = await seedSign("sorted");
    await setSignStatus(
      {
        clientId: "cs-note-1",
        signId: s.id,
        status: "deployed",
        changedAt: new Date(),
        notes: "handed off to deploy team",
      },
      actorA,
    );
    const history = await prisma.statusHistory.findFirst({ where: { signId: s.id } });
    expect(history?.notes).toBe("handed off to deploy team");
  });

  it("replaying the same clientId is an idempotent duplicate (no second row)", async () => {
    const s = await seedSign("sorted");
    const req = {
      clientId: "cs-dup-1",
      signId: s.id,
      status: "deployed" as const,
      changedAt: new Date(),
    };
    const first = await setSignStatus(req, actorA);
    expect(first.result).toBe("applied");
    const second = await setSignStatus(req, actorA);
    expect(second.result).toBe("duplicate");

    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(1); // not double-inserted
  });

  it("concurrent replay of the same clientId: one applied, one duplicate, one row (P2002 path)", async () => {
    const s = await seedSign("sorted");
    const req = {
      clientId: "cs-race-1",
      signId: s.id,
      status: "deployed" as const,
      changedAt: new Date(),
    };
    const [r1, r2] = await Promise.all([
      setSignStatus(req, actorA),
      setSignStatus(req, actorB),
    ]);
    // Exactly one applied; the loser is reported duplicate (via the unique-index
    // P2002 catch), never a dishonest second apply.
    expect([r1.result, r2.result].sort()).toEqual(["applied", "duplicate"]);

    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(1); // the rolled-back loser wrote nothing
  });

  it("last-writer-wins for different clientIds on the same sign", async () => {
    const s = await seedSign("pending");
    await setSignStatus(
      { clientId: "cs-lww-a", signId: s.id, status: "printed", changedAt: new Date() },
      actorA,
    );
    await setSignStatus(
      { clientId: "cs-lww-b", signId: s.id, status: "delivered", changedAt: new Date() },
      actorB,
    );
    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("delivered");
    // Both changes are in the audited trail.
    const history = await prisma.statusHistory.findMany({
      where: { signId: s.id },
      orderBy: { id: "asc" },
    });
    expect(history.map((h) => h.newStatus)).toEqual(["printed", "delivered"]);
  });

  it("a same-status change is a no-op (no history row written)", async () => {
    const s = await seedSign("sorted");
    const res = await setSignStatus(
      { clientId: "cs-noop-1", signId: s.id, status: "sorted", changedAt: new Date() },
      actorA,
    );
    expect(res.result).toBe("noop");
    const history = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(history).toHaveLength(0);
  });

  it("returns not_found for a sign that doesn't exist", async () => {
    const res = await setSignStatus(
      { clientId: "cs-missing-1", signId: 999999, status: "deployed", changedAt: new Date() },
      actorA,
    );
    expect(res).toEqual({ signId: 999999, status: "deployed", result: "not_found" });
  });

  it("moving below delivered clears the delivery/deploy stamps", async () => {
    const s = await seedSign("pending");
    // Up to deployed (stamps set), then back to pending (stamps cleared).
    await setSignStatus(
      { clientId: "cs-stamp-up", signId: s.id, status: "deployed", changedAt: new Date() },
      actorA,
    );
    await setSignStatus(
      { clientId: "cs-stamp-down", signId: s.id, status: "pending", changedAt: new Date() },
      actorA,
    );
    const row = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(row?.status).toBe("pending");
    expect(row?.deployedAt).toBeNull();
    expect(row?.deployedBy).toBeNull();
    expect(row?.deliveredAt).toBeNull();
  });
});
