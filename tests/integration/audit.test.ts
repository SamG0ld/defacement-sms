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
