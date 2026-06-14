import { afterEach, expect, it } from "vitest";

import { GET } from "@/app/api/cron/purge-login-audit/route";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  delete process.env.CRON_SECRET;
});

it("recordAudit persists login context (location + userAgent)", async () => {
  await recordAudit({
    action: "auth.login",
    actorId: "u1",
    actorEmail: "u1@example.com",
    detail: "google",
    location: "Las Vegas, US",
    userAgent: "Mozilla/5.0 (iPhone) Safari",
  });
  const rows = await prisma.auditLog.findMany({ where: { action: "auth.login" } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actorEmail: "u1@example.com",
    location: "Las Vegas, US",
    userAgent: "Mozilla/5.0 (iPhone) Safari",
  });
});

it("admin audit events leave login context null", async () => {
  await recordAudit({ action: "user.add", actorId: "a", detail: "x@y.z" });
  const row = await prisma.auditLog.findFirst({ where: { action: "user.add" } });
  expect(row?.location).toBeNull();
  expect(row?.userAgent).toBeNull();
});

function cronRequest(bearer: string): Request {
  return new Request("http://localhost/api/cron/purge-login-audit", {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

it("purge deletes only auth.* rows older than the retention window", async () => {
  process.env.CRON_SECRET = "test-secret";
  const old = new Date(Date.now() - 100 * DAY);
  const recent = new Date(Date.now() - 1 * DAY);
  await prisma.auditLog.createMany({
    data: [
      { action: "auth.login", createdAt: old }, // purged
      { action: "auth.denied", createdAt: old }, // purged
      { action: "auth.login", createdAt: recent }, // kept (within window)
      { action: "user.add", createdAt: old }, // kept (admin event, never purged)
    ],
  });

  const res = await GET(cronRequest("test-secret"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ purged: 2 });

  expect(await prisma.auditLog.count({ where: { action: "auth.login" } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { action: "auth.denied" } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { action: "user.add" } })).toBe(1);
});

it("purge rejects a missing or wrong secret (fails closed)", async () => {
  process.env.CRON_SECRET = "test-secret";
  expect((await GET(cronRequest("wrong"))).status).toBe(401);

  delete process.env.CRON_SECRET;
  expect((await GET(cronRequest("anything"))).status).toBe(401);
});
