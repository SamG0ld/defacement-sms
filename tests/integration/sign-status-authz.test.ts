// H2 (#17) + #20 regression: sign-status changes are authorized consistently
// across every entry point. Volunteers are forward-only and need their crew's
// claim to mark a sign `deployed`; backward moves are lead/admin only; leads/
// admins are unrestricted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT");
    (e as unknown as { redirectUrl: string }).redirectUrl = url;
    throw e;
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOTFOUND");
  }),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  claimSigns,
  createCrew,
  setSignStatus,
  setSignStatusBatch,
} from "@/lib/deploy/service";
import type { ApiActor } from "@/lib/deploy/api-types";
import { updateSignStatus } from "@/app/(app)/signs/actions";
import { bulkSetStatus } from "@/app/(app)/signs/bulk-actions";

const vol: ApiActor = { userId: "uVol", email: "vol@example.com", role: "volunteer" };
const other: ApiActor = { userId: "uOther", email: "other@example.com", role: "volunteer" };
const lead: ApiActor = { userId: "uLead", email: "lead@example.com", role: "lead" };

let seq = 0;
function seedSign(status = "sorted", over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.sign.create({
    data: {
      itemId: `A-${seq}`,
      signText: `S${seq}`,
      signType: "Sign",
      size: "22x28",
      status: status as never,
      ...over,
    },
  });
}

// A sorted sign claimed by `owner`'s crew; returns { signId, crewId }.
async function claimedSign(owner: ApiActor) {
  seq += 1;
  const crew = await createCrew({ name: `Crew-${seq}` }, owner);
  const sign = await seedSign("sorted");
  await claimSigns({ clientId: `claim-${seq}`, crewId: crew.id, signIds: [sign.id] }, owner);
  return { signId: sign.id, crewId: crew.id };
}

function setStatus(signId: number, status: string, actor: ApiActor) {
  seq += 1;
  return setSignStatus(
    { clientId: `cs-${seq}`, signId, status: status as never, changedAt: new Date() },
    actor,
  );
}

function signedInAs(actor: ApiActor) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: actor.userId, email: actor.email, role: actor.role, isActive: true },
  } as never);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function captureRedirect(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { redirectUrl?: string }).redirectUrl;
    if (url !== undefined) return url;
    throw e;
  }
  throw new Error("expected a redirect, but none was thrown");
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  seq = 0; // reset so seeded ids never depend on prior tests' run order (#63)
});
afterEach(() => vi.clearAllMocks());

// ── Native offline-sync API (the #17 surface) ────────────────────────────────
describe("setSignStatus (native) — volunteer authorization", () => {
  it("applies deployed when the volunteer's crew holds the claim", async () => {
    const { signId } = await claimedSign(vol);
    const res = await setStatus(signId, "deployed", vol);
    expect(res.result).toBe("applied");
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("deployed");
  });

  it("forbids marking deployed on a sign claimed by a DIFFERENT crew", async () => {
    const { signId } = await claimedSign(other); // claimed by other's crew, not vol's
    const res = await setStatus(signId, "deployed", vol);
    expect(res.result).toBe("forbidden");
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("sorted");
  });

  it("forbids marking deployed on an unclaimed sign", async () => {
    const sign = await seedSign("sorted");
    const res = await setStatus(sign.id, "deployed", vol);
    expect(res.result).toBe("forbidden");
  });

  it("forbids a backward move by a volunteer (deployed → sorted), even on their own claim", async () => {
    const { signId } = await claimedSign(vol);
    await setStatus(signId, "deployed", vol); // applied
    const res = await setStatus(signId, "sorted", vol);
    expect(res.result).toBe("forbidden");
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("deployed");
  });

  it("allows a forward prep transition (printed → sorted) on an unclaimed sign", async () => {
    const sign = await seedSign("printed");
    const res = await setStatus(sign.id, "sorted", vol);
    expect(res.result).toBe("applied");
  });

  it("allows a lead to move a sign backward (deployed → sorted)", async () => {
    const { signId } = await claimedSign(vol);
    await setStatus(signId, "deployed", vol);
    const res = await setStatus(signId, "sorted", lead);
    expect(res.result).toBe("applied");
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("sorted");
  });

  it("forbids a volunteer setting handed_off via the generic path (lead/admin only)", async () => {
    const { signId } = await claimedSign(vol);
    const res = await setStatus(signId, "handed_off", vol);
    expect(res.result).toBe("forbidden");
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("sorted");
  });

  // #232: the /signs row status control commits through the offline OUTBOX, which
  // syncs here — not through updateSignStatus. Putting the category rule in the
  // shared policy is what makes the outbox refuse what the dropdown refuses,
  // instead of leaving the queue as a way around it.
  it("forbids a lead setting installed on a non-external sign (offline-sync path)", async () => {
    const sign = await seedSign("delivered", { category: "easel_sign" });
    const res = await setStatus(sign.id, "installed", lead);
    expect(res.result).toBe("forbidden");
    const after = await prisma.sign.findUnique({ where: { id: sign.id } });
    expect(after?.status).toBe("delivered");
    expect(after?.installedAt).toBeNull();
    expect(await prisma.statusHistory.count({ where: { signId: sign.id } })).toBe(0);
  });

  it("allows a lead setting installed on an external item (offline-sync path)", async () => {
    const sign = await seedSign("delivered", { category: "ops_map" });
    const res = await setStatus(sign.id, "installed", lead);
    expect(res.result).toBe("applied");
    expect((await prisma.sign.findUnique({ where: { id: sign.id } }))?.status).toBe(
      "installed",
    );
  });

  it("emits a structured warn line on a forbidden refusal so on-call can search it (#77)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sign = await seedSign("sorted");
      const res = await setStatus(sign.id, "deployed", vol); // unclaimed → forbidden
      expect(res.result).toBe("forbidden");
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("deploy.set-status.forbidden"));
      expect(line).toBeDefined();
      expect(line).toContain(`"signId":${sign.id}`);
      expect(line).toContain(`"attemptedStatus":"deployed"`);
    } finally {
      // Restore in a finally so a failed assertion can't leave console.warn
      // suppressed for the rest of the file (afterEach only clears call history).
      warn.mockRestore();
    }
  });
});

// ── Native batch — per-change authorization, no cross-contamination ───────────
describe("setSignStatusBatch (native) — per-change authorization", () => {
  it("echoes forbidden for the unauthorized change without blocking the permitted one", async () => {
    const { signId: mine } = await claimedSign(vol); // vol's crew holds this
    const { signId: theirs } = await claimedSign(other); // another crew's claim
    seq += 1;
    const res = await setSignStatusBatch(
      {
        changes: [
          { clientId: `b1-${seq}`, signId: mine, status: "deployed" as never, changedAt: new Date() },
          { clientId: `b2-${seq}`, signId: theirs, status: "deployed" as never, changedAt: new Date() },
        ],
      },
      vol,
    );
    const byId = new Map(res.results.map((r) => [r.signId, r.result]));
    expect(byId.get(mine)).toBe("applied");
    expect(byId.get(theirs)).toBe("forbidden");
    expect((await prisma.sign.findUnique({ where: { id: mine } }))?.status).toBe("deployed");
    expect((await prisma.sign.findUnique({ where: { id: theirs } }))?.status).toBe("sorted");
  });
});

// ── Online single Server Action ──────────────────────────────────────────────
describe("updateSignStatus (online) — volunteer authorization", () => {
  it("rejects marking deployed without the crew's claim", async () => {
    const sign = await seedSign("sorted");
    signedInAs(vol);
    const url = await captureRedirect(updateSignStatus(sign.id, form({ status: "deployed" })));
    expect(url).toContain("error=");
    expect((await prisma.sign.findUnique({ where: { id: sign.id } }))?.status).toBe("sorted");
  });

  it("allows marking deployed when the volunteer's crew holds the claim", async () => {
    const { signId } = await claimedSign(vol);
    signedInAs(vol);
    await updateSignStatus(signId, form({ status: "deployed" })); // resolves (success redirects only on error)
    expect((await prisma.sign.findUnique({ where: { id: signId } }))?.status).toBe("deployed");
  });
});

// ── Online bulk Server Action (the #20 blast-radius surface) ─────────────────
describe("bulkSetStatus (#20) — volunteer is intersected to their claimed signs", () => {
  it("an allMatching deploy touches only signs the volunteer's crew claimed", async () => {
    const crew = await createCrew({ name: "VolCrew" }, vol);
    const mineA = await seedSign("sorted");
    const mineB = await seedSign("sorted");
    await claimSigns({ clientId: "c-mine", crewId: crew.id, signIds: [mineA.id, mineB.id] }, vol);

    const otherCrew = await createCrew({ name: "OtherCrew" }, other);
    const theirs = await seedSign("sorted");
    await claimSigns({ clientId: "c-theirs", crewId: otherCrew.id, signIds: [theirs.id] }, other);

    const unclaimed = await seedSign("sorted");

    signedInAs(vol);
    await captureRedirect(bulkSetStatus(form({ setStatus: "deployed", allMatching: "1" })));

    const statusOf = async (id: number) =>
      (await prisma.sign.findUnique({ where: { id } }))?.status;
    expect(await statusOf(mineA.id)).toBe("deployed");
    expect(await statusOf(mineB.id)).toBe("deployed");
    expect(await statusOf(theirs.id)).toBe("sorted"); // another crew's claim — untouched
    expect(await statusOf(unclaimed.id)).toBe("sorted"); // unclaimed — untouched
  });
});
