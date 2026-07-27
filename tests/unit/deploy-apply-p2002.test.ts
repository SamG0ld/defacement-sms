import { beforeEach, describe, expect, it, vi } from "vitest";

// #268 (backstop half): a unique-constraint violation inside applyDeploys' batch
// transaction must NOT escape. If it does, runApi turns it into a 500, the deploy
// client classifies 5xx as "stop" (app/(app)/deploy/_lib/sync.ts), and the outbox
// entry is left pending forever — blocking every deploy queued behind it for the
// rest of the con.
//
// This is a UNIT test on purpose. The archived guard closed the one known route to
// a P2002 here (the guarded write no longer moves a row out of `archived`, which
// was the only way into the #263 partial unique index), so the integration suite
// can no longer reach this catch through a legitimate DB path — verified: the
// remove→re-add→deploy-the-tombstone case in tests/integration/deploy-actions.test.ts
// now resolves to `conflict` via the guard, never reaching the transaction. Forcing
// the rejection at the seam is the only way to prove the backstop still holds.
vi.mock("@/lib/db", () => ({
  prisma: {
    deployEvent: { findMany: vi.fn() },
    sign: { findMany: vi.fn() },
    crewMember: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/log", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
// Pulls in @vercel/blob at module load; applyDeploys never touches it.
vi.mock("@/lib/deploy/blob", () => ({
  uploadDeployPhoto: vi.fn(),
  streamDeployPhoto: vi.fn(),
  deleteDeployPhoto: vi.fn(),
}));

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { logWarn } from "@/lib/log";
import { applyDeploys } from "@/lib/deploy/service";
import type { ApiActor } from "@/lib/deploy/api-types";

const actor: ApiActor = {
  userId: "u1",
  email: "u1@example.com",
  role: "volunteer",
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.9.0",
    meta: { target: ["item_id", "sheet_name", "category"] },
  });

function event(clientId: string, signId: number) {
  return { clientId, signId, crewId: null, deployedAt: new Date() };
}

beforeEach(() => {
  vi.mocked(prisma.deployEvent.findMany).mockResolvedValue([]);
  vi.mocked(prisma.crewMember.findMany).mockResolvedValue([]);
  vi.mocked(prisma.sign.findMany).mockResolvedValue([
    { id: 1, status: "sorted" },
    { id: 2, status: "sorted" },
  ] as never);
  vi.mocked(logWarn).mockClear();
});

describe("applyDeploys — a P2002 must not escape as a 500 (#268)", () => {
  it("reports the batch as conflicts instead of throwing", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(p2002());

    const res = await applyDeploys(
      { events: [event("a", 1), event("b", 2)] },
      actor,
    );

    // Both events rolled back with the transaction, so neither applied — and the
    // caller gets a resolved response, not an exception that becomes a 500.
    expect(res.results).toEqual([
      { clientId: "a", signId: 1, status: "conflict" },
      { clientId: "b", signId: 2, status: "conflict" },
    ]);
  });

  it("logs the violation at warn (searchable on the floor, no Sentry page)", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(p2002());

    await applyDeploys({ events: [event("a", 1)] }, actor);

    expect(logWarn).toHaveBeenCalledWith(
      "deploy.apply.unique-violation",
      expect.any(String),
      expect.objectContaining({ actorId: "u1", clientIds: ["a"] }),
    );
  });

  it("still rethrows anything that isn't a P2002", async () => {
    // A connection drop or a bug must keep surfacing as a 500 — swallowing every
    // error here would silently report undeployed signs as resolved conflicts.
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("connection lost"));

    await expect(
      applyDeploys({ events: [event("a", 1)] }, actor),
    ).rejects.toThrow("connection lost");
  });
});
