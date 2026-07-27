// #69: HTTP-layer coverage for the native bootstrap read path — the cold-start
// load every field device makes. Proves the auth gate (401) and the 200 working-
// set envelope (crews / myCrewIds / signs / cursor) the client depends on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { ApiActor } from "@/lib/deploy/api-types";
import { GET } from "@/app/api/native/sync/bootstrap/route";

const actor: ApiActor = { userId: "uA", email: "a@example.com", role: "volunteer" };

function signedInAs(a: ApiActor, isActive = true) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: a.userId, email: a.email, role: a.role, isActive },
  } as never);
}
function signedOut() {
  vi.mocked(auth).mockResolvedValue(null as never);
}
function bootstrapGet() {
  return GET(
    new Request("http://localhost/api/native/sync/bootstrap", { method: "GET" }),
  );
}

beforeEach(() => vi.mocked(auth).mockReset());
afterEach(() => vi.clearAllMocks());

describe("GET /api/native/sync/bootstrap", () => {
  it("200: returns the working set + a cursor", async () => {
    await prisma.sign.create({
      data: {
        itemId: "BR-1",
        signText: "Bootstrap",
        signType: "Sign",
        size: "22x28",
        status: "sorted" as never,
      },
    });
    signedInAs(actor);

    const res = await bootstrapGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.cursor).toBe("string");
    expect(Array.isArray(body.crews)).toBe(true);
    expect(Array.isArray(body.myCrewIds)).toBe(true);
    expect(Array.isArray(body.signs)).toBe(true);
    expect(
      body.signs.some((s: { itemId: string }) => s.itemId === "BR-1"),
    ).toBe(true);
  });

  it("401: rejects an unauthenticated caller", async () => {
    signedOut();
    const res = await bootstrapGet();
    expect(res.status).toBe(401);
  });

  it("403: rejects a deactivated account (#79)", async () => {
    signedInAs(actor, false);
    const res = await bootstrapGet();
    expect(res.status).toBe(403);
  });
});
