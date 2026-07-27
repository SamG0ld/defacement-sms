// #69: HTTP-layer coverage for the native sign-status batch write path. The
// drain the /signs offline queue hits on reconnect. Proves the route wiring —
// auth gate (401/403), schema validation (400), the 200 envelope — and the
// server half of #99 (a refused change echoes result:"forbidden" with a 200, so
// the client can dead-letter it with feedback rather than treating it as ok).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { ApiActor } from "@/lib/deploy/api-types";
import { POST } from "@/app/api/native/sign-status/batch/route";

const lead: ApiActor = { userId: "uL", email: "lead@example.com", role: "lead" };
const vol: ApiActor = { userId: "uVol", email: "vol@example.com", role: "volunteer" };

function signedInAs(a: ApiActor, isActive = true) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: a.userId, email: a.email, role: a.role, isActive },
  } as never);
}
function signedOut() {
  vi.mocked(auth).mockResolvedValue(null as never);
}
function batchPost(body: unknown) {
  return POST(
    new Request("http://localhost/api/native/sign-status/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

let seq = 0;
async function seedSign(status: string) {
  seq += 1;
  return prisma.sign.create({
    data: {
      itemId: `SB-${seq}`,
      signText: "Batch route",
      signType: "Sign",
      size: "22x28",
      status: status as never,
    },
  });
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  seq = 0; // reset so seeded ids never depend on prior tests' run order (#63)
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/native/sign-status/batch", () => {
  it("200: applies a change and echoes per-change results keyed by clientId", async () => {
    const sign = await seedSign("printed");
    signedInAs(lead);

    const res = await batchPost({
      changes: [
        {
          clientId: "ss-route-1",
          signId: sign.id,
          status: "delivered",
          changedAt: new Date().toISOString(),
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { clientId: "ss-route-1", signId: sign.id, status: "delivered", result: "applied" },
    ]);
  });

  it("200 + forbidden: a refused change echoes forbidden (server half of #99)", async () => {
    // A volunteer marking a sign deployed without their crew's claim is refused.
    const sign = await seedSign("sorted");
    signedInAs(vol);

    const res = await batchPost({
      changes: [
        {
          clientId: "ss-route-forbidden",
          signId: sign.id,
          status: "deployed",
          changedAt: new Date().toISOString(),
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].result).toBe("forbidden");
  });

  it("401: rejects an unauthenticated caller", async () => {
    signedOut();
    const res = await batchPost({ changes: [] });
    expect(res.status).toBe(401);
  });

  it("403: rejects a deactivated account (#79)", async () => {
    signedInAs(lead, false);
    const res = await batchPost({ changes: [] });
    expect(res.status).toBe(403);
  });

  it("400: rejects a malformed body", async () => {
    signedInAs(lead);
    const res = await batchPost({ changes: "nope" });
    expect(res.status).toBe(400);
  });
});
