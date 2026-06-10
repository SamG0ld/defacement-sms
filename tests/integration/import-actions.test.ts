import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/ratelimit", () => ({
  checkActionRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 99,
    reset: 0,
  })),
  checkAuthRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 99,
    reset: 0,
  })),
  isRateLimitConfigured: () => false,
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { executeImport } from "@/app/(app)/signs/import/actions";

const session = {
  user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
};
beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

const CSV = "Map#,Sign Text,Qty\nA1,Sign One,2\nA2,Sign Two,1";

it("imports valid rows as test data with per-sign history + an audit row", async () => {
  const res = await executeImport(CSV, false, true, "generic");
  expect(res.imported).toBe(2);

  const signs = await prisma.sign.findMany({ orderBy: { itemId: "asc" } });
  expect(signs).toHaveLength(2);
  expect(signs.every((s) => s.isTestData)).toBe(true);
  expect(signs.every((s) => s.status === "pending")).toBe(true);

  const hist = await prisma.statusHistory.findMany({
    orderBy: { id: "asc" },
  });
  expect(hist).toHaveLength(2);
  expect(hist[0].notes).toBe("Imported from CSV");

  const audit = await prisma.auditLog.findMany({
    where: { action: "signs.import" },
  });
  expect(audit).toHaveLength(1);
  expect(audit[0].detail).toContain("Imported 2 signs");
});

it("skips rows already in the DB when includeDuplicates is false", async () => {
  await executeImport(CSV, false, true, "generic");
  const res = await executeImport(CSV, false, true, "generic");
  expect(res.imported).toBe(0);
  expect(res.skipped).toBe(2);
  expect(await prisma.sign.count()).toBe(2);
});

it("throws when the file exceeds the row cap", async () => {
  const header = "Map#,Sign Text,Qty\n";
  const rows = Array.from(
    { length: 2001 },
    (_, i) => `R${i},Sign ${i},1`,
  ).join("\n");
  await expect(
    executeImport(header + rows, false, true, "generic"),
  ).rejects.toThrow("too-many-rows");
});
