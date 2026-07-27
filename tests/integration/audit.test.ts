import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
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
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  clearAllSigns,
  clearTestSigns,
} from "@/app/(app)/signs/manage/actions";
import { setUserRole } from "@/app/(app)/users/actions";
import { updateSignStatus } from "@/app/(app)/signs/actions";

const admin = {
  user: { id: "admin1", email: "admin@example.com", isActive: true, role: "admin" },
};
beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(admin as never);
});
afterEach(() => vi.clearAllMocks());

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

const base = { signText: "x", signType: "Sign", size: "22x28" };

it("recordAudit writes a row", async () => {
  await recordAudit({
    action: "test.thing",
    actorId: "x",
    actorEmail: "x@y.z",
    detail: "hi",
  });
  const rows = await prisma.auditLog.findMany({ where: { action: "test.thing" } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: "x", detail: "hi" });
});

it("clearTestSigns deletes only test data and audits", async () => {
  await prisma.sign.createMany({
    data: [
      { ...base, itemId: "T1", isTestData: true },
      { ...base, itemId: "T2", isTestData: true },
      { ...base, itemId: "R1", isTestData: false },
    ],
  });
  const url = await captureRedirect(clearTestSigns());
  expect(url).toContain("done=");

  const remaining = await prisma.sign.findMany();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].itemId).toBe("R1");
  expect(
    await prisma.auditLog.count({ where: { action: "signs.clear_test" } }),
  ).toBe(1);
});

it("setUserRole records the PRIOR role in the audit detail", async () => {
  // beforeEach truncates the domain tables but preserves `users` (seeded
  // reference data), so clear any leftover from a prior run before recreating.
  await prisma.user.deleteMany({ where: { email: "vol@example.com" } });
  const user = await prisma.user.create({
    data: { email: "vol@example.com", role: "volunteer" },
  });

  const fd = new FormData();
  fd.set("role", "lead");
  await setUserRole(user.id, fd);

  const rows = await prisma.auditLog.findMany({ where: { action: "user.role" } });
  expect(rows).toHaveLength(1);
  // The detail must reconstruct the transition on its own — recording only the
  // NEW role would erase the escalation timeline (#82).
  expect(rows[0].detail).toContain("volunteer");
  expect(rows[0].detail).toContain("lead");
  expect(rows[0].detail).toMatch(/from volunteer to lead/);
});

it("updateSignStatus audits a DENIED status change", async () => {
  // A volunteer attempting a backward move is rejected by decideStatusChange;
  // the denial must still leave an audit trace so a privilege probe is visible.
  const volunteer = {
    user: {
      id: "vol1",
      email: "vol1@example.com",
      isActive: true,
      role: "volunteer",
    },
  };
  vi.mocked(auth).mockResolvedValue(volunteer as never);

  const sign = await prisma.sign.create({
    data: { ...base, itemId: "D1", status: "printed" },
  });

  const fd = new FormData();
  fd.set("status", "pending"); // backward: printed -> pending

  const url = await captureRedirect(updateSignStatus(sign.id, fd));
  expect(url).toContain("error=");

  // Sign status is unchanged...
  const after = await prisma.sign.findUnique({ where: { id: sign.id } });
  expect(after?.status).toBe("printed");

  // ...but the denied attempt is recorded.
  const rows = await prisma.auditLog.findMany({
    where: { action: "sign.status_denied" },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].actorId).toBe("vol1");
  expect(rows[0].detail).toContain(`sign #${sign.id}`);
  expect(rows[0].detail).toMatch(/printed → pending/);
});

it("clearAllSigns requires the exact confirm phrase", async () => {
  await prisma.sign.create({ data: { ...base, itemId: "X1" } });
  const fd = new FormData();
  fd.set("confirm", "nope");
  const url = await captureRedirect(clearAllSigns(fd));
  expect(url).toContain("error=");
  expect(await prisma.sign.count()).toBe(1); // untouched
});

it("clearAllSigns wipes everything with the confirm phrase", async () => {
  await prisma.sign.createMany({
    data: [
      { ...base, itemId: "A" },
      { ...base, itemId: "B", isTestData: true },
    ],
  });
  const fd = new FormData();
  fd.set("confirm", "DELETE ALL SIGNS");
  const url = await captureRedirect(clearAllSigns(fd));
  expect(url).toContain("done=");
  expect(await prisma.sign.count()).toBe(0);
  expect(
    await prisma.auditLog.count({ where: { action: "signs.clear_all" } }),
  ).toBe(1);
});
