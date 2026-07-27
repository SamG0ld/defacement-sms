import { afterEach, describe, expect, it, vi } from "vitest";

// Unit-test the readiness probe in isolation. Mock the Prisma singleton so we can
// drive `SELECT 1` to succeed or throw without a real database — and so importing
// the route never loads the real adapter/generated client.
vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn() },
}));

import { prisma } from "@/lib/db";
import { GET } from "@/app/api/ready/route";

const queryRaw = vi.mocked(prisma.$queryRaw);

afterEach(() => vi.clearAllMocks());

describe("GET /api/ready", () => {
  it("returns 200 ready when the DB answers SELECT 1", async () => {
    queryRaw.mockResolvedValueOnce([]); // route ignores rows — only resolve-vs-reject matters
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ready" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 503 not_ready when the DB query throws", async () => {
    queryRaw.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: "not_ready" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not leak the underlying DB error detail in the response body", async () => {
    queryRaw.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });
});
