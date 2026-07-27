// H1 (#16) regression: the deploy-photo upload route must enforce that only the
// user who logged a deploy event (or a lead/admin) can attach/overwrite its
// photo. Before the fix, any active user who knew a `clientId` could silently
// replace another user's field evidence.
//
// The ownership gate runs BEFORE the body is read or any blob is written, so we
// can prove it without mocking blob storage or crafting a valid image: a denied
// caller gets 403, while an allowed caller falls through to a 400 on the dummy
// (non-image) bytes. The 403-vs-not-403 distinction is the assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { applyDeploys, claimSigns, createCrew } from "@/lib/deploy/service";
import type { ApiActor } from "@/lib/deploy/api-types";
import { GET, POST } from "@/app/api/native/deploys/[clientId]/photo/route";
import { routeParams } from "../helpers/route-params";

const actorA: ApiActor = { userId: "uA", email: "a@example.com", role: "volunteer" };
const actorB: ApiActor = { userId: "uB", email: "b@example.com", role: "volunteer" };
const lead: ApiActor = { userId: "uL", email: "lead@example.com", role: "lead" };
const admin: ApiActor = { userId: "uAd", email: "admin@example.com", role: "admin" };

// Make requireApiSession resolve to the given actor (mirrors NextAuth's session shape).
function signedInAs(actor: ApiActor) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: actor.userId, email: actor.email, role: actor.role, isActive: true },
  } as never);
}

// Build a POST request to the photo route. No Origin / sec-fetch-site headers, so
// the same-origin CSRF guard treats it as a non-browser call and passes. The body
// is intentionally not a valid image — allowed callers should reach (and fail at)
// image validation, never the 403 gate.
function photoPost(clientId: string) {
  const req = new Request(`http://localhost/api/native/deploys/${clientId}/photo`, {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
  });
  return POST(req, { params: routeParams({ clientId }) });
}

function photoGet(clientId: string) {
  const req = new Request(
    `http://localhost/api/native/deploys/${clientId}/photo`,
    { method: "GET" },
  );
  return GET(req, { params: routeParams({ clientId }) });
}

let seq = 0;
// Seed a deploy event owned by `owner`, returning its clientId. Unique per call
// so the helper is safe to invoke more than once within a test.
async function seedDeployOwnedBy(owner: ApiActor): Promise<string> {
  seq += 1;
  const crew = await createCrew({ name: `Crew-${seq}` }, owner);
  const sign = await prisma.sign.create({
    data: { itemId: `PH-${seq}`, signText: "Photo sign", signType: "Sign", size: "22x28", status: "sorted" as never },
  });
  await claimSigns({ clientId: `claim-${seq}`, crewId: crew.id, signIds: [sign.id] }, owner);
  const clientId = `dep-ph-${seq}`;
  await applyDeploys(
    { events: [{ clientId, signId: sign.id, crewId: crew.id, deployedAt: new Date() }] },
    owner,
  );
  return clientId;
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  signedInAs(actorA); // default resolved value so a test can't race on an unset mock (#68)
  seq = 0; // reset so assertions never depend on prior tests' run order (#68/#63)
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/native/deploys/[clientId]/photo — ownership gate (H1)", () => {
  it("rejects a different volunteer with 403 (cannot overwrite another user's photo)", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    signedInAs(actorB);

    const res = await photoPost(clientId);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not your deploy event" });
  });

  it("lets the owning user past the gate (fails later on image validation, not 403)", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    signedInAs(actorA);

    const res = await photoPost(clientId);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("lets a lead override the owner (not 403)", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    signedInAs(lead);

    const res = await photoPost(clientId);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("lets an admin override the owner (not 403)", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    signedInAs(admin);

    const res = await photoPost(clientId);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("returns 404 for an unknown deploy event (no ownership leak)", async () => {
    signedInAs(actorB);

    const res = await photoPost("does-not-exist");

    expect(res.status).toBe(404);
  });

  // A null owner (legacy/imported events) is treated as lead-only: the `!==`
  // check fails for every actor, so only lead/admin can attach.
  it("treats a null-owner event as lead-only: volunteer gets 403", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    await prisma.deployEvent.update({ where: { clientId }, data: { deployedByUserId: null } });
    signedInAs(actorB);

    const res = await photoPost(clientId);

    expect(res.status).toBe(403);
  });

  it("treats a null-owner event as lead-only: lead is allowed past the gate (not 403)", async () => {
    const clientId = await seedDeployOwnedBy(actorA);
    await prisma.deployEvent.update({ where: { clientId }, data: { deployedByUserId: null } });
    signedInAs(lead);

    const res = await photoPost(clientId);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/native/deploys/[clientId]/photo — session-check error path (#74)", () => {
  it("returns a generic 500 when the session check throws a non-ApiError", async () => {
    // A non-ApiError from requireApiSession (e.g. the auth layer itself faulting)
    // must fall through the GET catch to a generic 500 — never leak the error.
    vi.mocked(auth).mockRejectedValue(new Error("unexpected"));
    const res = await photoGet("any-client-id");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
