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
import {
  applyReconcile,
  previewReconcile,
} from "@/app/(app)/signs/reconcile/actions";

const session = {
  user: { id: "lead1", email: "lead@example.com", isActive: true, role: "lead" },
};
beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

// One matched space (Cloud Village @ W311) whose sheet dictates a printed-text
// override, plus a brand-new space (New Thing @ W999). No "in the hall?" column, so
// no socks are fabricated.
const CSV = [
  "Department,Name,Level,Room,Additional Signage Request",
  'Village,Cloud Village,Level 1,W311,"text should be ""Crypto Village"""',
  "Contest,New Thing,Level 2,W999,",
].join("\n");

// Two matched spaces, both carrying a printed-text override, so one apply batch
// holds two accepted changes (the shape #220's race needs).
const CSV_TWO_CHANGES = [
  "Department,Name,Level,Room,Additional Signage Request",
  'Village,Cloud Village,Level 1,W311,"text should be ""Crypto Village"""',
  'Contest,Beverage Cooling,Level 2,W312,"text should be ""Beverage Cooling Contraption Contest"""',
].join("\n");

// Three brand-new spaces in three DIFFERENT departments, so each add must land its
// own department tag — the pairing assertion #240 asks for.
const CSV_THREE_ADDS = [
  "Department,Name,Level,Room,Additional Signage Request",
  "Village,Alpha Village,Level 1,W401,",
  "Contest,Beta Contest,Level 2,W402,",
  "Workshop,Gamma Workshop,Level 1,W403,",
].join("\n");

async function tagId(slug: string): Promise<number> {
  const t = await prisma.signTag.findUniqueOrThrow({ where: { slug } });
  return t.id;
}

// A minimal master-sheet-scoped sign (real, master-sheet tagged + its department).
async function seedSheetSign(opts: {
  itemId: string;
  name: string;
  deptSlug: string;
}) {
  const [masterSheet, dept] = await Promise.all([
    tagId("master-sheet"),
    tagId(opts.deptSlug),
  ]);
  return prisma.sign.create({
    data: {
      itemId: opts.itemId,
      signText: opts.name,
      sheetName: opts.name,
      signType: "Meterboard",
      size: "OLD-SIZE",
      category: "meterboard",
      isTestData: false,
      tagAssignments: { create: [{ tagId: masterSheet }, { tagId: dept }] },
    },
  });
}

// A master-sheet sign already in the app (sheetName "Cloud Village"), carrying
// team-owned sizing + app-owned state (deployed + taken from QM) that reconcile must
// never touch. Tagged master-sheet (so it's in scope) + village (its department).
async function seedMatchedSign() {
  const [masterSheet, village] = await Promise.all([
    tagId("master-sheet"),
    tagId("village"),
  ]);
  return prisma.sign.create({
    data: {
      itemId: "W311",
      signText: "Cloud Village",
      sheetName: "Cloud Village",
      signType: "Meterboard",
      size: "OLD-SIZE",
      category: "meterboard",
      printable: true,
      doubleSided: false,
      needsEasel: false,
      quantity: 1,
      placementArea: "old placement",
      notes: null,
      isTestData: false,
      status: "deployed",
      qmTakenAt: new Date("2026-06-01T00:00:00Z"),
      qmTakenBy: "alice",
      deployedBy: "bob",
      tagAssignments: { create: [{ tagId: masterSheet }, { tagId: village }] },
    },
  });
}

it("applies a signText override and leaves team-owned + app-owned fields untouched", async () => {
  const sign = await seedMatchedSign();

  const preview = await previewReconcile(CSV);
  expect(preview.headerError).toBeNull();

  const change = preview.result.changes.find((c) => c.signId === sign.id);
  expect(change).toBeDefined();
  // Only the printed text moves — matched by sheetName, so it's a change not an add.
  expect(change!.fields).toEqual([
    { field: "signText", from: "Cloud Village", to: "Crypto Village" },
  ]);
  const add = preview.result.adds.find((a) => a.sheet.itemId === "W999");
  expect(add).toBeDefined();

  const res = await applyReconcile(CSV, {
    adds: [add!.identity],
    changes: [change!.identity],
  });
  expect(res).toMatchObject({ added: 1, changed: 1, failed: 0 });

  const updated = await prisma.sign.findUniqueOrThrow({ where: { id: sign.id } });

  // The printed text updated...
  expect(updated.signText).toBe("Crypto Village");
  // ...but the identifier, the team-owned size (the sheet implies 4'x8' Double for a
  // village — never applied), and every app-owned field are exactly as seeded.
  expect(updated.sheetName).toBe("Cloud Village");
  expect(updated.size).toBe("OLD-SIZE");
  expect(updated.status).toBe("deployed");
  expect(updated.qmTakenBy).toBe("alice");
  expect(updated.qmTakenAt).not.toBeNull();
  expect(updated.deployedBy).toBe("bob");
  expect(updated.isTestData).toBe(false);

  // The ADD created a real, pending sign with sheetName + the master-sheet tag (so
  // it's itself in scope for future reconciles) and a reconcile history row.
  const created = await prisma.sign.findFirstOrThrow({
    where: { itemId: "W999" },
    include: { tagAssignments: { include: { tag: true } } },
  });
  expect(created.status).toBe("pending");
  expect(created.isTestData).toBe(false);
  expect(created.sheetName).toBe("New Thing");
  const slugs = created.tagAssignments.map((a) => a.tag.slug);
  expect(slugs).toContain("master-sheet");
  expect(slugs).toContain("contest");
  const hist = await prisma.statusHistory.findMany({
    where: { signId: created.id },
  });
  expect(hist.some((h) => h.notes === "Added via sheet reconcile")).toBe(true);

  const audit = await prisma.auditLog.findMany({
    where: { action: "signs.reconcile" },
  });
  expect(audit.some((a) => (a.detail ?? "").includes("Reconciled"))).toBe(true);
});

it("applies nothing when no rows are accepted", async () => {
  const sign = await seedMatchedSign();
  const res = await applyReconcile(CSV, { adds: [], changes: [] });
  expect(res).toMatchObject({ added: 0, changed: 0 });

  const unchanged = await prisma.sign.findUniqueOrThrow({
    where: { id: sign.id },
  });
  expect(unchanged.signText).toBe("Cloud Village");
  expect(await prisma.sign.count()).toBe(1); // no W999 add
});

it("never considers a non-master-sheet sign (all-venue standing sign) for removal", async () => {
  await seedMatchedSign();
  const tag = await prisma.signTag.findUniqueOrThrow({
    where: { slug: "all-venue" },
  });
  const standing = await prisma.sign.create({
    data: {
      itemId: "AV-COC",
      signText: "Code of Conduct",
      signType: "Meterboard",
      size: "4'x8'",
      category: "meterboard",
      isTestData: false,
      tagAssignments: { create: { tagId: tag.id } },
    },
  });

  const preview = await previewReconcile(CSV);
  expect(preview.result.removes.some((r) => r.signId === standing.id)).toBe(false);
});

// #220 — a sign deleted between applyReconcile's fresh scope read and the write loop
// must cost only ITS row. Before the fix the P2025 from that one update propagated
// out of the transaction callback and rolled the whole batch back (changed 0,
// failed 2), discarding every other accepted correction with no way to tell which
// row broke.
it("isolates a concurrently-deleted sign so the rest of the batch still applies", async () => {
  const cloud = await seedSheetSign({
    itemId: "W311",
    name: "Cloud Village",
    deptSlug: "village",
  });
  const bev = await seedSheetSign({
    itemId: "W312",
    name: "Beverage Cooling",
    deptSlug: "contest",
  });

  const preview = await previewReconcile(CSV_TWO_CHANGES);
  const cloudChange = preview.result.changes.find((c) => c.signId === cloud.id);
  const bevChange = preview.result.changes.find((c) => c.signId === bev.id);
  expect(cloudChange).toBeDefined();
  expect(bevChange).toBeDefined();

  // Reproduce the race deterministically: one-shot spy on the only
  // prisma.sign.findMany applyReconcile makes (loadSheetSourcedSigns). It returns
  // the real rows — so the diff still sees both signs — then deletes one, exactly
  // the window between the read and the write.
  const realFindMany = prisma.sign.findMany.bind(prisma.sign) as (
    args?: unknown,
  ) => Promise<unknown>;
  const spy = vi.spyOn(prisma.sign, "findMany").mockImplementation((async (
    args?: unknown,
  ) => {
    spy.mockRestore();
    const rows = await realFindMany(args);
    await prisma.sign.delete({ where: { id: cloud.id } });
    return rows;
  }) as typeof prisma.sign.findMany);

  let res;
  try {
    res = await applyReconcile(CSV_TWO_CHANGES, {
      adds: [],
      changes: [cloudChange!.identity, bevChange!.identity],
    });
  } finally {
    spy.mockRestore(); // no-op if the implementation already restored it
  }

  expect(res).toMatchObject({ changed: 1, failed: 1 });
  // ...and the lead is told exactly which accepted change didn't land.
  expect(res.failedIds).toEqual([cloud.id]);

  const survivor = await prisma.sign.findUniqueOrThrow({ where: { id: bev.id } });
  expect(survivor.signText).toBe("Beverage Cooling Contraption Contest");
  // The write moved from `update` to `updateMany`, so pin the @updatedAt stamp:
  // the offline delta-pull sync selects on updatedAt (@@index([status, updatedAt])),
  // and a reconcile change that didn't move it would never reach a field device.
  expect(survivor.updatedAt.getTime()).toBeGreaterThan(bev.updatedAt.getTime());
});

// #240 — the add path must pair each returned row with ITS OWN payload by identity,
// not by array position. Positional pairing is silently correct today and silently
// wrong the moment createManyAndReturn returns a different shape — which #228's
// skipDuplicates does, by dropping rows.
it("gives each reconcile-added sign its own tags and history, not its neighbour's", async () => {
  const preview = await previewReconcile(CSV_THREE_ADDS);
  expect(preview.result.adds).toHaveLength(3);

  const res = await applyReconcile(CSV_THREE_ADDS, {
    adds: preview.result.adds.map((a) => a.identity),
    changes: [],
  });
  expect(res).toMatchObject({ added: 3, changed: 0, failed: 0 });

  const deptByRoom: Record<string, string> = {
    W401: "village",
    W402: "contest",
    W403: "workshop",
  };
  const allDepts = Object.values(deptByRoom);

  for (const [itemId, deptSlug] of Object.entries(deptByRoom)) {
    const sign = await prisma.sign.findFirstOrThrow({
      where: { itemId },
      include: {
        tagAssignments: { include: { tag: true } },
        statusHistory: true,
      },
    });
    const slugs = sign.tagAssignments.map((a) => a.tag.slug);
    expect(slugs).toContain("master-sheet");
    expect(slugs).toContain(deptSlug);
    // Crucially: it carries NO other add's department.
    for (const other of allDepts) {
      if (other !== deptSlug) expect(slugs).not.toContain(other);
    }
    expect(sign.statusHistory).toHaveLength(1);
    expect(sign.statusHistory[0].notes).toBe("Added via sheet reconcile");
  }
});

// #236 — changes apply in bounded chunks (CHANGE_CHUNK = 100) rather than one
// batch-wide transaction. Every other test here has ≤3 changes and so never crosses a
// chunk boundary; this one spans two, covering the slice arithmetic and proving a
// realistic multi-chunk resync applies completely.
it("applies a change batch that spans multiple chunks", async () => {
  const COUNT = 150;
  const [masterSheet, village] = await Promise.all([
    tagId("master-sheet"),
    tagId("village"),
  ]);
  const rows = Array.from({ length: COUNT }, (_, i) => ({
    itemId: `W${600 + i}`,
    name: `Space ${i}`,
  }));

  await prisma.sign.createMany({
    data: rows.map((r) => ({
      itemId: r.itemId,
      signText: r.name,
      sheetName: r.name,
      signType: "Meterboard",
      size: "OLD-SIZE",
      category: "meterboard" as const,
      isTestData: false,
    })),
  });
  const seeded = await prisma.sign.findMany({
    where: { itemId: { in: rows.map((r) => r.itemId) } },
    select: { id: true },
  });
  await prisma.signTagAssignment.createMany({
    data: seeded.flatMap((s) => [
      { signId: s.id, tagId: masterSheet },
      { signId: s.id, tagId: village },
    ]),
  });

  const csv = [
    "Department,Name,Level,Room,Additional Signage Request",
    ...rows.map(
      (r) => `Village,${r.name},Level 1,${r.itemId},"text should be ""New ${r.name}"""`,
    ),
  ].join("\n");

  const preview = await previewReconcile(csv);
  expect(preview.result.changes).toHaveLength(COUNT);

  const res = await applyReconcile(csv, {
    adds: [],
    changes: preview.result.changes.map((c) => c.identity),
  });
  expect(res).toMatchObject({ changed: COUNT, failed: 0, failedIds: [] });

  // Every row across both chunks actually took its new text.
  const applied = await prisma.sign.count({
    where: { signText: { startsWith: "New Space " } },
  });
  expect(applied).toBe(COUNT);
});

// #228 — the add path must survive an identity the DB already has, and must SAY it
// skipped it. The reachable case: a sign with the same (itemId, sheetName, category)
// that is NOT master-sheet tagged, so the diff can't see it and classifies the sheet
// row as an add — but the index still blocks the insert.
it("skips an add the DB already has and reports it instead of failing", async () => {
  const preview = await previewReconcile(CSV_THREE_ADDS);
  expect(preview.result.adds).toHaveLength(3);

  // Untagged, so loadSheetSourcedSigns never returns it and W402 still reads as an add.
  await prisma.sign.create({
    data: {
      itemId: "W402",
      signText: "Beta Contest",
      sheetName: "Beta Contest",
      signType: "Foamcore",
      size: "22x28",
      category: "easel_sign",
      isTestData: false,
    },
  });

  const res = await applyReconcile(CSV_THREE_ADDS, {
    adds: preview.result.adds.map((a) => a.identity),
    changes: [],
  });

  // The other two land, the collision is skipped — not a failure, but not silent.
  expect(res).toMatchObject({ added: 2, changed: 0, failed: 0, skippedAdds: 1 });
  expect(await prisma.sign.count({ where: { itemId: "W402" } })).toBe(1);
  // ...and the two that did land still got their own tags (identity pairing holds
  // even though createManyAndReturn returned fewer rows than were submitted).
  const alpha = await prisma.sign.findFirstOrThrow({
    where: { itemId: "W401" },
    include: { tagAssignments: { include: { tag: true } } },
  });
  expect(alpha.tagAssignments.map((a) => a.tag.slug)).toContain("village");
});

// #228 — the DB-level guard. Scoped so it blocks a repeat sheet identity without
// touching the shapes the app legitimately produces.
it("blocks a duplicate sheet identity at the DB, without over-constraining socks or QM piles", async () => {
  const base = {
    itemId: "W500",
    signText: "Dup Space",
    sheetName: "Dup Space",
    signType: "Meterboard",
    size: "4'x8' Double",
    category: "meterboard" as const,
    isTestData: false,
  };
  await prisma.sign.create({ data: base });
  await expect(prisma.sign.create({ data: base })).rejects.toMatchObject({
    code: "P2002",
  });

  // A master primary and its sock share itemId AND sheetName by design and differ
  // only by category — the parser emits them as a matched pair, so they must coexist.
  await prisma.sign.create({
    data: { ...base, category: "socks", size: "Socks" },
  });
  expect(await prisma.sign.count({ where: { itemId: "W500" } })).toBe(2);

  // All-venue QM piles are N rows with NULL sheet_name — exempt, since Postgres
  // treats NULLs as distinct in a unique index.
  const pile = {
    itemId: "AV-DUP",
    signText: "Pile",
    signType: "Meterboard",
    size: "4'x8'",
    category: "meterboard" as const,
    isTestData: false,
  };
  await prisma.sign.create({ data: pile });
  await prisma.sign.create({ data: pile });
  expect(await prisma.sign.count({ where: { itemId: "AV-DUP" } })).toBe(2);

  // Test fixtures are exempt too (the index is partial on is_test_data = false).
  await prisma.sign.create({ data: { ...base, itemId: "T1", isTestData: true } });
  await prisma.sign.create({ data: { ...base, itemId: "T1", isTestData: true } });
  expect(await prisma.sign.count({ where: { itemId: "T1" } })).toBe(2);

  // A soft-removal tombstone coexisting with a live row is the INTENDED end state of
  // remove-then-re-add, not a double create — `archived` is retained precisely so the
  // removal stays reversible. Without the status predicate this pair fails the index,
  // which is what took staging down at 2026-07-25 02:16 UTC (real tombstones, correct
  // data). Predicate lives in 20260725030000_exempt_archived_from_sheet_identity_unique.
  const readded = {
    itemId: "W501",
    signText: "Removed Then Re-added",
    sheetName: "Removed Then Re-added",
    signType: "Meterboard",
    size: "4'x8' Double",
    category: "meterboard" as const,
    isTestData: false,
  };
  await prisma.sign.create({ data: { ...readded, status: "archived" } });
  await prisma.sign.create({ data: readded });
  expect(await prisma.sign.count({ where: { itemId: "W501" } })).toBe(2);

  // ...but the race this guard exists for produces two LIVE rows, still blocked.
  await expect(prisma.sign.create({ data: readded })).rejects.toMatchObject({
    code: "P2002",
  });
});
