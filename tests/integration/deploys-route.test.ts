// #69: HTTP-layer coverage for the native deploy write path. applyDeploys itself
// is tested elsewhere; this proves the ROUTE wiring that actually reaches field
// devices — the auth gate (401/403), schema validation (400), and the 200
// envelope — none of which the service-level tests exercise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { ApiActor } from "@/lib/deploy/api-types";
import { POST } from "@/app/api/native/deploys/route";

const actor: ApiActor = { userId: "uA", email: "a@example.com", role: "volunteer" };

function signedInAs(a: ApiActor, isActive = true) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: a.userId, email: a.email, role: a.role, isActive },
  } as never);
}
function signedOut() {
  vi.mocked(auth).mockResolvedValue(null as never);
}
function deploysPost(body: unknown) {
  return POST(
    new Request("http://localhost/api/native/deploys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

let seq = 0;
async function seedSortedSign() {
  seq += 1;
  return prisma.sign.create({
    data: {
      itemId: `DR-${seq}`,
      signText: "Deploy route",
      signType: "Sign",
      size: "22x28",
      status: "sorted" as never,
    },
  });
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  seq = 0; // reset so seeded ids never depend on prior tests' run order (#63)
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/native/deploys", () => {
  it("200: applies a deploy and echoes the result envelope", async () => {
    const sign = await seedSortedSign();
    signedInAs(actor);

    const res = await deploysPost({
      events: [
        {
          clientId: "dep-route-1",
          signId: sign.id,
          crewId: null,
          deployedAt: new Date().toISOString(),
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { clientId: "dep-route-1", signId: sign.id, status: "applied" },
    ]);
    const after = await prisma.sign.findUnique({
      where: { id: sign.id },
      select: { status: true },
    });
    expect(after?.status).toBe("deployed");
  });

  it("401: rejects an unauthenticated caller", async () => {
    signedOut();
    const res = await deploysPost({ events: [] });
    expect(res.status).toBe(401);
  });

  it("403: rejects a deactivated account (#79 — client dead-letters, never retries)", async () => {
    signedInAs(actor, false);
    const res = await deploysPost({ events: [] });
    expect(res.status).toBe(403);
  });

  it("400: rejects a malformed body", async () => {
    signedInAs(actor);
    const res = await deploysPost({ events: "not-an-array" });
    expect(res.status).toBe(400);
  });
});
