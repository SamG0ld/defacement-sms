import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking strategy as bulk-actions: redirect/revalidate/auth are mocked,
// Prisma is real. archive/restore end in redirect() (success OR failure), so
// every call is wrapped in captureRedirect.
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
import { bulkArchive, bulkRestore } from "@/app/(app)/signs/remove-actions";
import { bulkSetStatus } from "@/app/(app)/signs/bulk-actions";
import { buildSignWhere } from "@/app/(app)/signs/_lib";
import { buildGroupWhere, countGroup, listQmGroups } from "@/lib/qm-stock";
import { signIdentitySelect } from "@/lib/stock";

const admin = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "admin" },
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

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function seed(over: Record<string, unknown> = {}) {
  return prisma.sign.create({
    data: {
      itemId: "SEED",
      signText: "Seed",
      signType: "Sign",
      size: "22x28",
      ...over,
    },
  });
}

const ids = (xs: { id: number }[]) => JSON.stringify(xs.map((x) => x.id));

describe("bulkArchive", () => {
  it("archives only pending/generated, skips printed+ (with a notice), and logs history + keeps the blob", async () => {
    const pending = await seed({ itemId: "P", status: "pending" });
    const generated = await seed({
      itemId: "G",
      status: "generated",
      previewImagePath: "signs/preview/g.png",
    });
    const printed = await seed({ itemId: "PR", status: "printed" });
    const deployed = await seed({ itemId: "D", status: "deployed" });

    const url = await captureRedirect(
      bulkArchive(form({ ids: ids([pending, generated, printed, deployed]) })),
    );
    // Success (not an error redirect) but carries a skipped-count notice.
    expect(url).not.toContain("error=");
    expect(url).toContain("notice=");
    expect(url).toContain("skipped");

    const rows = await prisma.sign.findMany({
      where: {
        id: { in: [pending.id, generated.id, printed.id, deployed.id] },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pending.id)?.status).toBe("archived");
    expect(byId.get(generated.id)?.status).toBe("archived");
    // Printed / deployed are physical — never removed here.
    expect(byId.get(printed.id)?.status).toBe("printed");
    expect(byId.get(deployed.id)?.status).toBe("deployed");
    // Preview blob is kept so a restore is clean (not orphaned/cleared).
    expect(byId.get(generated.id)?.previewImagePath).toBe("signs/preview/g.png");

    // One history row per archived sign (old → archived).
    const hist = await prisma.statusHistory.findMany({
      where: { signId: { in: [pending.id, generated.id] }, newStatus: "archived" },
    });
    expect(hist).toHaveLength(2);
    expect(hist.find((h) => h.signId === generated.id)?.oldStatus).toBe(
      "generated",
    );

    // Audit trail records the removal, under the bulk.* prefix every other bulk
    // action in this slice uses (#186) — archive/restore are selection-wide ops,
    // not single-sign ones, so a consumer grouping by prefix must not read them
    // as sign.* actions.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "bulk.archive" },
    });
    expect(audit).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: "sign.archive" } }),
    ).toBe(0);
  });

  it("archives all eligible signs matching a tag filter (allMatching)", async () => {
    // A test-unique tag name/slug: sign_tags is NOT in the per-test truncate
    // list (other suites rely on the seeded vocabulary), so a common name like
    // "Training" collides with the reference seed. upsert-by-slug keeps it
    // idempotent across the run regardless.
    const tag = await prisma.signTag.upsert({
      where: { slug: "remove-test-class" },
      update: {},
      create: { name: "Remove-Test Class", slug: "remove-test-class" },
    });
    const g1 = await seed({ itemId: "T1", status: "generated" });
    const g2 = await seed({ itemId: "T2", status: "pending" });
    const printed = await seed({ itemId: "T3", status: "printed" });
    for (const s of [g1, g2, printed]) {
      await prisma.signTagAssignment.create({
        data: { signId: s.id, tagId: tag.id },
      });
    }

    await captureRedirect(
      bulkArchive(form({ allMatching: "1", tag: "remove-test-class" })),
    );

    const archived = await prisma.sign.count({ where: { status: "archived" } });
    expect(archived).toBe(2); // the two eligible; the printed one stays
    expect(
      (await prisma.sign.findUnique({ where: { id: printed.id } }))?.status,
    ).toBe("printed");
  });

  it("refuses when nothing in the selection is eligible", async () => {
    const printed = await seed({ itemId: "PR", status: "printed" });
    const url = await captureRedirect(bulkArchive(form({ ids: ids([printed]) })));
    expect(url).toContain("error=");
    expect(
      (await prisma.sign.findUnique({ where: { id: printed.id } }))?.status,
    ).toBe("printed");
  });
});

describe("archived signs are hidden from the live record", () => {
  it("buildSignWhere excludes archived by default and shows only archived on the Removed view", async () => {
    const live = await seed({ itemId: "L", status: "generated" });
    const gone = await seed({ itemId: "X", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([gone]) })));

    const def = await prisma.sign.findMany({ where: buildSignWhere({}) });
    const defIds = def.map((r) => r.id);
    expect(defIds).toContain(live.id);
    expect(defIds).not.toContain(gone.id);

    const removed = await prisma.sign.findMany({
      where: buildSignWhere({ status: "archived" }),
    });
    expect(removed.map((r) => r.id)).toEqual([gone.id]);
  });

  it("excludes archived signs from the QM pile rollup (listQmGroups)", async () => {
    // A pile of 3 identical signs; remove one and the pile total drops to 2.
    await seed({ itemId: "QM", signText: "Pile", status: "pending" });
    await seed({ itemId: "QM", signText: "Pile", status: "pending" });
    const c = await seed({ itemId: "QM", signText: "Pile", status: "pending" });

    const before = (await listQmGroups()).find((g) => g.signText === "Pile");
    expect(before?.total).toBe(3);

    await captureRedirect(bulkArchive(form({ ids: ids([c]) })));

    const after = (await listQmGroups()).find((g) => g.signText === "Pile");
    expect(after?.total).toBe(2);
  });

  it("bulkSetStatus never moves an archived sign (no un-archive bypass)", async () => {
    const gone = await seed({ itemId: "X", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([gone]) })));

    // Even an admin bulk-setting it to a lifecycle status leaves it archived —
    // the only exit is Restore.
    await captureRedirect(
      bulkSetStatus(form({ ids: ids([gone]), setStatus: "generated" })),
    );
    expect(
      (await prisma.sign.findUnique({ where: { id: gone.id } }))?.status,
    ).toBe("archived");
  });

  it("excludes archived signs from QM group counts", async () => {
    // Two physically identical signs (one QM pile), both eligible for removal.
    const a = await seed({ itemId: "QM", signText: "Booth", status: "pending" });
    const b = await seed({ itemId: "QM", signText: "Booth", status: "pending" });
    const rep = await prisma.sign.findUnique({
      where: { id: a.id },
      select: signIdentitySelect,
    });
    const before = await countGroup(prisma, buildGroupWhere(rep!));
    expect(before.total).toBe(2);

    await captureRedirect(bulkArchive(form({ ids: ids([b]) })));

    const after = await countGroup(prisma, buildGroupWhere(rep!));
    expect(after.total).toBe(1); // the removed sign no longer counts at QM
  });
});

describe("listQmGroups — group representative (#242)", () => {
  it("shows the itemId of the row repId points at, and sorts on that same itemId", async () => {
    // The pile's lowest-id row is deliberately NOT the one with the lexically
    // smallest itemId. Before the fix the displayed itemId came from the lowest-id
    // row, the sort key from MIN(item_id), and repId from MIN(id) — up to three
    // different rows, so the label could contradict the list position.
    const first = await seed({ itemId: "QM-9", signText: "Rep", status: "pending" });
    const second = await seed({ itemId: "QM-1", signText: "Rep", status: "pending" });

    const group = (await listQmGroups()).find((g) => g.signText === "Rep");
    expect(group).toBeDefined();
    // Displayed itemId is the sort key (MIN(item_id)) ...
    expect(group?.itemId).toBe("QM-1");
    // ... and repId is that very row, not the lowest-id one.
    expect(group?.repId).toBe(second.id);
    expect(group?.repId).not.toBe(first.id);

    // repId must still resolve to a real member of the group (take/return derives
    // the whole pile from it).
    const rep = await prisma.sign.findUnique({ where: { id: group!.repId } });
    expect(rep?.itemId).toBe(group?.itemId);
    expect(rep?.signText).toBe("Rep");
  });

  it("is deterministic when a pile's copies share one itemId (the common case)", async () => {
    // itemId is indexed but NOT unique, and QM copies routinely reuse it — so the
    // representative pick needs its id tiebreak to be stable across runs.
    const a = await seed({ itemId: "QM", signText: "Same", status: "pending" });
    await seed({ itemId: "QM", signText: "Same", status: "pending" });
    await seed({ itemId: "QM", signText: "Same", status: "pending" });

    const once = (await listQmGroups()).find((g) => g.signText === "Same");
    const twice = (await listQmGroups()).find((g) => g.signText === "Same");
    expect(once?.repId).toBe(a.id); // lowest id wins the tie
    expect(twice?.repId).toBe(once?.repId);
    expect(once?.total).toBe(3);
  });
});

describe("bulkRestore", () => {
  it("restores archived signs back to their prior status with history", async () => {
    const pending = await seed({ itemId: "P", status: "pending" });
    const generated = await seed({ itemId: "G", status: "generated" });
    await captureRedirect(
      bulkArchive(form({ ids: ids([pending, generated]) })),
    );

    const url = await captureRedirect(
      bulkRestore(form({ ids: ids([pending, generated]) })),
    );
    expect(url).not.toContain("error=");

    const rows = await prisma.sign.findMany({
      where: { id: { in: [pending.id, generated.id] } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pending.id)?.status).toBe("pending"); // back to prior
    expect(byId.get(generated.id)?.status).toBe("generated");

    const hist = await prisma.statusHistory.findMany({
      where: { signId: generated.id, oldStatus: "archived" },
    });
    expect(hist).toHaveLength(1);
    expect(hist[0].newStatus).toBe("generated");

    // Same bulk.* convention as archive (#186).
    expect(
      await prisma.auditLog.findFirst({ where: { action: "bulk.restore" } }),
    ).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: "sign.restore" } }),
    ).toBe(0);
  });

  it("restoring an already-restored sign never writes a second history row", async () => {
    // End-state guard for the #222 re-filter: a restore only ever records a
    // transition that actually happened. (The lock itself is what makes this hold
    // under concurrency; this pins the sequential invariant it must not break.)
    const gone = await seed({ itemId: "RR", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([gone]) })));
    await captureRedirect(bulkRestore(form({ ids: ids([gone]) })));
    await captureRedirect(bulkRestore(form({ ids: ids([gone]) })));

    expect(
      await prisma.statusHistory.count({
        where: { signId: gone.id, oldStatus: "archived" },
      }),
    ).toBe(1);
    expect(
      (await prisma.sign.findUnique({ where: { id: gone.id } }))?.status,
    ).toBe("generated");
  });

  it("only restores archived rows in the selection, leaving live signs untouched (with a skipped notice)", async () => {
    const live = await seed({ itemId: "L", status: "generated" });
    const gone = await seed({ itemId: "X", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([gone]) })));

    const url = await captureRedirect(
      bulkRestore(form({ ids: ids([live, gone]) })),
    );
    // The live sign was skipped — surfaced, not silent.
    expect(url).toContain("notice=");
    expect(url).toContain("skipped");

    // The already-live sign is unchanged; the archived one comes back.
    expect(
      (await prisma.sign.findUnique({ where: { id: live.id } }))?.status,
    ).toBe("generated");
    expect(
      (await prisma.sign.findUnique({ where: { id: gone.id } }))?.status,
    ).toBe("generated");
  });
});

// #264: #263 relaxed the sheet-identity unique index to exclude `archived`, so a
// tombstone can coexist with its re-added live twin. Restoring that tombstone
// moves the row back INTO the index predicate and raises P2002 — which, before
// this fix, rolled back the whole chunk (up to CHUNK-1 legitimate restores) and
// told the lead to "try again", advice that can never work.
describe("bulkRestore — sheet-identity collisions (#264)", () => {
  // A sheet-sourced sign: real (not test data) with a sheetName, so it falls
  // inside the partial index predicate. Anything else can't collide.
  function seedSheet(over: Record<string, unknown> = {}) {
    return seed({ sheetName: "Payment Village", isTestData: false, ...over });
  }

  it("skips the colliding tombstone, still restores the rest of the selection", async () => {
    const tombstone = await seedSheet({ itemId: "W204", status: "generated" });
    const innocent = await seed({ itemId: "INNOCENT", status: "generated" });
    await captureRedirect(
      bulkArchive(form({ ids: ids([tombstone, innocent]) })),
    );
    // The re-add: a NEW live row with the same (itemId, sheetName, category).
    const twin = await seedSheet({ itemId: "W204", status: "pending" });

    const url = await captureRedirect(
      bulkRestore(form({ ids: ids([tombstone, innocent]) })),
    );

    // No P2002 escape hatch, no generic "please try again".
    expect(url).not.toContain("error=");
    expect(url).toContain("notice=");
    const notice = decodeURIComponent(url);
    expect(notice).toContain("W204"); // named, so the lead knows WHICH sign
    expect(notice).toMatch(/already uses that room, sheet name and item type/i);

    // The innocent row in the same chunk restored; the colliding one stayed put.
    expect(
      (await prisma.sign.findUnique({ where: { id: innocent.id } }))?.status,
    ).toBe("generated");
    expect(
      (await prisma.sign.findUnique({ where: { id: tombstone.id } }))?.status,
    ).toBe("archived");
    // …and the live twin was never touched.
    expect(
      (await prisma.sign.findUnique({ where: { id: twin.id } }))?.status,
    ).toBe("pending");
    // A skipped row must not get a history row for a transition that never happened.
    expect(
      await prisma.statusHistory.count({
        where: { signId: tombstone.id, oldStatus: "archived" },
      }),
    ).toBe(0);
  });

  it("two tombstones on ONE identity: the first restores, the rest are named — no chunk rollback", async () => {
    // Multiple tombstones per identity is a legal steady state: the index
    // excludes archived rows entirely, so remove → re-add → remove leaves two.
    // Neither shows up in the live-holder lookup, so without a self-check both
    // would move into the predicate in the SAME updateMany and raise P2002,
    // rolling back the whole chunk — the exact failure this fix exists to remove.
    // Built the only way the DB allows: the second copy can't exist until the
    // first is archived — which is exactly how remove → re-add → remove gets here.
    const first = await seedSheet({ itemId: "W600", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([first]) })));
    const second = await seedSheet({ itemId: "W600", status: "generated" });
    const innocent = await seed({ itemId: "BYSTANDER", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([second, innocent]) })));

    const url = await captureRedirect(
      bulkRestore(form({ ids: ids([first, second, innocent]) })),
    );
    expect(url).not.toContain("error=");
    const notice = decodeURIComponent(url);
    expect(notice).toContain("W600");
    expect(notice).toMatch(/another sign in this selection shares/i);

    // The bystander in the same chunk survived — no rollback.
    expect(
      (await prisma.sign.findUnique({ where: { id: innocent.id } }))?.status,
    ).toBe("generated");
    // Exactly one of the pair came back; the other stayed removed.
    const pair = await prisma.sign.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(pair.filter((r) => r.status === "archived")).toHaveLength(1);
    expect(pair.filter((r) => r.status !== "archived")).toHaveLength(1);
  });

  it("a blocked tombstone is still restorable once the live twin is gone", async () => {
    const tombstone = await seedSheet({ itemId: "W300", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([tombstone]) })));
    const twin = await seedSheet({ itemId: "W300", status: "pending" });

    await captureRedirect(bulkRestore(form({ ids: ids([tombstone]) })));
    expect(
      (await prisma.sign.findUnique({ where: { id: tombstone.id } }))?.status,
    ).toBe("archived");

    await prisma.sign.delete({ where: { id: twin.id } });
    const url = await captureRedirect(bulkRestore(form({ ids: ids([tombstone]) })));
    expect(url).not.toContain("error=");
    expect(
      (await prisma.sign.findUnique({ where: { id: tombstone.id } }))?.status,
    ).toBe("generated");
  });

  it("does not over-skip: a same-identity TEST-DATA twin is outside the index and restores fine", async () => {
    // The index predicate is `is_test_data = false AND sheet_name IS NOT NULL`.
    // A test-data twin can't collide, so blocking on it would be a false refusal.
    const tombstone = await seedSheet({ itemId: "W400", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([tombstone]) })));
    await seedSheet({ itemId: "W400", status: "pending", isTestData: true });

    const url = await captureRedirect(bulkRestore(form({ ids: ids([tombstone]) })));
    expect(url).not.toContain("error=");
    expect(
      (await prisma.sign.findUnique({ where: { id: tombstone.id } }))?.status,
    ).toBe("generated");
  });

  it("does not over-skip: a live sign sharing itemId but NOT sheetName restores fine", async () => {
    const tombstone = await seedSheet({ itemId: "W500", status: "generated" });
    await captureRedirect(bulkArchive(form({ ids: ids([tombstone]) })));
    await seedSheet({
      itemId: "W500",
      sheetName: "A Different Space",
      status: "pending",
    });

    const url = await captureRedirect(bulkRestore(form({ ids: ids([tombstone]) })));
    expect(url).not.toContain("error=");
    expect(
      (await prisma.sign.findUnique({ where: { id: tombstone.id } }))?.status,
    ).toBe("generated");
  });
});
