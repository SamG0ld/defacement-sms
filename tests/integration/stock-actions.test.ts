import { execSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is REAL (the FOR UPDATE lock + clientId idempotency are the whole point
// of this suite). Only auth + revalidatePath are mocked, same as the other
// server-action integration tests.
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

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { takeFromQm, returnToQm } from "@/app/(app)/signs/stock-actions";

// A plain volunteer — the action is open to any active user (no role gate).
const session = {
  user: { id: "qm1", email: "qm@example.com", isActive: true, role: "volunteer" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

// Seed a pile: `count` identical qty-1 rows (one group). `taken` of them start
// checked out (qmTakenAt set). Returns the representative (lowest) sign id — the
// action derives the whole group from it.
async function seedGroup(count = 10, taken = 0): Promise<number> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = await prisma.sign.create({
      data: {
        itemId: `AV-COC-${String(i + 1).padStart(2, "0")}`,
        signText: "Code of Conduct",
        signType: '24"x36"',
        size: '24"x36"',
        category: "easel_sign",
        quantity: 1,
        ...(i < taken ? { qmTakenAt: new Date(), qmTakenBy: "seed" } : {}),
      },
    });
    ids.push(s.id);
  }
  return Math.min(...ids);
}

// Taken rows in the Code-of-Conduct group (the only group in a truncated test DB).
function takenCount(): Promise<number> {
  return prisma.sign.count({
    where: { signText: "Code of Conduct", qmTakenAt: { not: null } },
  });
}

describe("takeFromQm / returnToQm", () => {
  it("takes from the pile, writes a ledger row, and decrements remaining", async () => {
    const rep = await seedGroup(10);
    const res = await takeFromQm({ signId: rep, n: 4, clientId: "c-take-1" });

    expect(res).toEqual({ ok: true, taken: 4, remaining: 6 });
    expect(await takenCount()).toBe(4);

    const ledger = await prisma.signStockCheckout.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      clientId: "c-take-1",
      delta: 4,
      byEmail: "qm@example.com",
    });
    // The ledger is keyed by the group, not a single sign.
    expect(ledger[0]?.groupKey).toContain("Code of Conduct");
  });

  it("returns to the pile (negative delta) and raises remaining", async () => {
    const rep = await seedGroup(10, 4); // 4 already out
    const res = await returnToQm({ signId: rep, n: 2, clientId: "c-ret-1" });

    expect(res).toEqual({ ok: true, taken: 2, remaining: 8 });
    expect(await takenCount()).toBe(2);
    const ledger = await prisma.signStockCheckout.findFirst();
    expect(ledger?.delta).toBe(-2);
  });

  it("is idempotent — replaying the same clientId is a no-op", async () => {
    const rep = await seedGroup(10);
    const first = await takeFromQm({ signId: rep, n: 4, clientId: "dup" });
    const replay = await takeFromQm({ signId: rep, n: 4, clientId: "dup" });

    expect(first).toEqual({ ok: true, taken: 4, remaining: 6 });
    // Same answer, but no further rows were flipped.
    expect(replay).toEqual({ ok: true, taken: 4, remaining: 6 });
    expect(await takenCount()).toBe(4);
    expect(await prisma.signStockCheckout.count()).toBe(1); // one row, two calls
  });

  it("refuses to oversell when taking more than remaining", async () => {
    const rep = await seedGroup(10, 7); // 3 left
    const res = await takeFromQm({ signId: rep, n: 4, clientId: "c-over" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Only 3 left at QM/);
    expect(await takenCount()).toBe(7); // unchanged — the partial flip rolled back
    // A rejected take leaves NO ledger row.
    expect(await prisma.signStockCheckout.count()).toBe(0);
  });

  it("refuses to return more than is checked out", async () => {
    const rep = await seedGroup(10, 2);
    const res = await returnToQm({ signId: rep, n: 5, clientId: "c-ret-bad" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Only 2 are checked out/);
    expect(await takenCount()).toBe(2);
  });

  it("two concurrent takes summing past the total don't oversell", async () => {
    const rep = await seedGroup(10); // 10 available
    // Each wants 7; only one can succeed (7+7 > 10). Plain FOR UPDATE serializes
    // them: the loser blocks, re-reads the committed state (3 left), and is
    // rejected — never a 5/5 split where both fail.
    const [a, b] = await Promise.all([
      takeFromQm({ signId: rep, n: 7, clientId: "race-a" }),
      takeFromQm({ signId: rep, n: 7, clientId: "race-b" }),
    ]);

    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(await takenCount()).toBe(7); // never 14
    expect(await prisma.signStockCheckout.count()).toBe(1); // only the winner
  });

  it("two concurrent takes sharing one clientId settle to one ledger row (double-tap / offline double-drain)", async () => {
    const rep = await seedGroup(10);
    // Same clientId in flight twice: the loser's tx rolls back on the unique
    // ledger index (or is caught by the in-lock dup-check) and must reconcile —
    // both callers get the SAME committed counts, and the flip applies once.
    const [a, b] = await Promise.all([
      takeFromQm({ signId: rep, n: 3, clientId: "double-tap" }),
      takeFromQm({ signId: rep, n: 3, clientId: "double-tap" }),
    ]);

    expect(a).toEqual({ ok: true, taken: 3, remaining: 7 });
    expect(b).toEqual({ ok: true, taken: 3, remaining: 7 });
    expect(await takenCount()).toBe(3); // applied once, not twice
    expect(await prisma.signStockCheckout.count()).toBe(1); // exactly one ledger row
  });

  it("a take of 1 flips exactly one pool row (the detail-page case)", async () => {
    const rep = await seedGroup(3);
    const res = await takeFromQm({ signId: rep, n: 1, clientId: "c-one" });
    expect(res).toEqual({ ok: true, taken: 1, remaining: 2 });
    expect(await takenCount()).toBe(1);
  });

  it("rejects a unique (singleton) sign — not a QM pile", async () => {
    const rep = await seedGroup(1); // a one-of-a-kind sign
    const res = await takeFromQm({ signId: rep, n: 1, clientId: "c-single" });
    expect(res).toEqual({ ok: false, error: "This sign isn't tracked at QM." });
    expect(await takenCount()).toBe(0); // nothing flipped
    expect(await prisma.signStockCheckout.count()).toBe(0);
  });

  it("reports a missing sign instead of throwing", async () => {
    const res = await takeFromQm({
      signId: 999999,
      n: 1,
      clientId: "c-missing",
    });
    expect(res).toEqual({ ok: false, error: "Sign not found." });
  });
});

describe("all-venue seed", () => {
  function runSeed() {
    // Run the real seed the same way prod/worktree-up does. execSync inherits the
    // test DATABASE_URL (load-env), and prisma.config.ts won't override it.
    execSync("npx prisma db execute --file prisma/seeds/all-venue-signs.sql", {
      stdio: "ignore",
    });
  }

  it("loads 97 individual signs across 9 groups with the all-venue tag, idempotently", async () => {
    runSeed();
    const rows = await prisma.sign.findMany({
      where: { itemId: { startsWith: "AV-" } },
      include: { tagAssignments: { include: { tag: true } } },
    });
    // Every standing sign is now its own qty-1 row.
    expect(rows).toHaveLength(97);
    expect(rows.every((r) => r.quantity === 1)).toBe(true);
    expect(rows.every((r) => r.qmTakenAt === null)).toBe(true);
    expect(rows.every((r) => !r.isTestData)).toBe(true);
    expect(
      rows.every((r) =>
        r.tagAssignments.some((a) => a.tag.slug === "all-venue"),
      ),
    ).toBe(true);
    // 9 distinct piles (by sign text).
    expect(new Set(rows.map((r) => r.signText)).size).toBe(9);

    // Re-run: still exactly 97 (WHERE NOT EXISTS on the deterministic item_id).
    runSeed();
    const count = await prisma.sign.count({
      where: { itemId: { startsWith: "AV-" } },
    });
    expect(count).toBe(97);
  });
});
