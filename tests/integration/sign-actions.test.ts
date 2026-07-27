import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Server Actions use redirect()/revalidatePath() as their terminal signal and
// auth() for authorization — all request-context APIs unavailable in a node test,
// so we mock them. Prisma is REAL (the point of these tests).
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
import {
  createSign,
  deleteSign,
  setHardwareCollected,
  setHardwareReturned,
  updateSign,
  updateSignStatus,
} from "@/app/(app)/signs/actions";
import { EMPTY_SIGN_FORM_STATE } from "@/app/(app)/signs/_form-state";

const session = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "admin" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
});
afterEach(() => vi.clearAllMocks());

// Actions signal success/failure by throwing through the mocked redirect(); pull
// the destination URL back out.
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
  // The real SignForm always submits a category (select defaults to easel_sign)
  // and the printable checkbox (defaults checked) — mirror that so the schema,
  // which requires category, validates. Explicit fields still override.
  for (const [k, v] of Object.entries({
    category: "easel_sign",
    printable: "on",
    ...fields,
  })) {
    fd.set(k, v);
  }
  return fd;
}

function seedSign(over: Record<string, unknown> = {}) {
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

describe("createSign", () => {
  it("writes a sign and redirects to its detail page", async () => {
    const url = await captureRedirect(
      createSign(
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "NEW-1",
          signText: "New Sign",
          signType: "Sign",
          size: "22x28",
          quantity: "3",
        }),
      ),
    );
    expect(url).toMatch(/^\/signs\/\d+$/);
    const sign = await prisma.sign.findFirst({ where: { itemId: "NEW-1" } });
    expect(sign?.signText).toBe("New Sign");
    expect(sign?.quantity).toBe(3);
    // category + printable flow through the create write-path.
    expect(sign?.category).toBe("easel_sign");
    expect(sign?.printable).toBe(true);
  });
});

describe("updateSignStatus", () => {
  it("advances status and records history", async () => {
    const s = await seedSign({ itemId: "S1" });
    await updateSignStatus(s.id, form({ status: "printed" }));

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("printed");
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      oldStatus: "pending",
      newStatus: "printed",
      changedBy: "lead@example.com",
    });
  });

  it("allows a direct jump to any status (pending → deployed) in one move", async () => {
    const s = await seedSign({ itemId: "S2" });
    await updateSignStatus(s.id, form({ status: "deployed" }));

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("deployed");
    expect(after?.deployedAt).not.toBeNull();
    expect(after?.deliveredAt).toBeNull(); // delivered was skipped → no stamp
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      oldStatus: "pending",
      newStatus: "deployed",
    });
  });

  it("rejects a no-op move to the same status", async () => {
    const s = await seedSign({ itemId: "S2b", status: "printed" });
    const url = await captureRedirect(
      updateSignStatus(s.id, form({ status: "printed" })),
    );
    expect(url).toContain("error=");
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("printed");
  });

  it("stamps a status history row with change_type='status' (the default)", async () => {
    const s = await seedSign({ itemId: "S-CT" });
    await updateSignStatus(s.id, form({ status: "printed" }));
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(1);
    expect(hist[0]?.changeType).toBe("status");
  });

  it("clears delivery stamps on rollback", async () => {
    const s = await seedSign({ itemId: "S3" });
    await updateSignStatus(s.id, form({ status: "printed" }));
    await updateSignStatus(s.id, form({ status: "delivered" }));

    let cur = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(cur?.deliveredAt).not.toBeNull();

    await updateSignStatus(s.id, form({ status: "printed" })); // rollback below delivered
    cur = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(cur?.deliveredAt).toBeNull();
    expect(cur?.deliveredBy).toBeNull();
  });

  it("delivered → sorted preserves deliveredAt and leaves deploy unstamped", async () => {
    const s = await seedSign({ itemId: "SORT1" });
    await updateSignStatus(s.id, form({ status: "delivered" }));
    const delAt = (await prisma.sign.findUnique({ where: { id: s.id } }))
      ?.deliveredAt;
    expect(delAt).not.toBeNull();

    await updateSignStatus(s.id, form({ status: "sorted" }));
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("sorted");
    expect(after?.deliveredAt).toEqual(delAt); // preserved
    expect(after?.deployedAt).toBeNull();
  });

  // #171: the status read + authz decision used to happen outside the write
  // transaction, so two concurrent submits for the same sign both decided against
  // the same snapshot and both committed — the loser recording an `oldStatus` it
  // never actually overwrote. The row lock serializes them, so the timeline is a
  // coherent chain whichever order they land in.
  it("concurrent status changes produce a coherent history chain (no stale oldStatus)", async () => {
    const s = await seedSign({ itemId: "RACE1", status: "pending" });

    await Promise.all([
      updateSignStatus(s.id, form({ status: "printed" })).catch(() => {}),
      updateSignStatus(s.id, form({ status: "delivered" })).catch(() => {}),
    ]);

    const hist = await prisma.statusHistory.findMany({
      where: { signId: s.id },
      orderBy: { id: "asc" },
    });
    expect(hist).toHaveLength(2);
    // The chain must link end-to-end: the second row's `from` is the first row's
    // `to`. Pre-fix, both rows carried oldStatus "pending".
    expect(hist[0].oldStatus).toBe("pending");
    expect(hist[1].oldStatus).toBe(hist[0].newStatus);
    // …and the sign ended where the last committed write left it.
    expect((await prisma.sign.findUnique({ where: { id: s.id } }))?.status).toBe(
      hist[1].newStatus,
    );
  });

  // #232: the terminal external statuses are reachable only on union_installed /
  // ops_map items, on EVERY path — including for a lead/admin, whose misclick is
  // the actual reported failure (LifecyclePanel never renders for the wrong class,
  // so there's no UI route back).
  it("refuses handed_off/installed on a non-external sign, even for an admin", async () => {
    const s = await seedSign({
      itemId: "EXT1",
      status: "delivered",
      category: "easel_sign",
    });
    const url = await captureRedirect(
      updateSignStatus(s.id, form({ status: "installed" })),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/external/i);

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("delivered");
    expect(after?.installedAt).toBeNull();
    expect(await prisma.statusHistory.count({ where: { signId: s.id } })).toBe(0);

    // The refusal is audited, not silently bounced (#83).
    const denied = await prisma.auditLog.findFirst({
      where: { action: "sign.status_denied" },
      orderBy: { createdAt: "desc" },
    });
    expect(denied?.detail).toContain(`sign #${s.id}`);
  });

  it("allows installed on an external item", async () => {
    const s = await seedSign({
      itemId: "EXT2",
      status: "delivered",
      category: "union_installed",
    });
    await updateSignStatus(s.id, form({ status: "installed" }));
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("installed");
    expect(after?.installedAt).not.toBeNull();
  });
});

describe("setHardwareCollected", () => {
  it("toggles equipmentCheckedOut", async () => {
    const s = await seedSign({ itemId: "HW1", needsEasel: true });
    await setHardwareCollected(s.id, form({ collected: "1" }));
    expect(
      (await prisma.sign.findUnique({ where: { id: s.id } }))
        ?.equipmentCheckedOut,
    ).toBe(true);

    await setHardwareCollected(s.id, form({ collected: "0" }));
    expect(
      (await prisma.sign.findUnique({ where: { id: s.id } }))
        ?.equipmentCheckedOut,
    ).toBe(false);
  });

  it("writes a sign.hardware audit row so the single-sign path matches bulk (#78)", async () => {
    const s = await seedSign({ itemId: "HW2", needsEasel: true });
    await setHardwareCollected(s.id, form({ collected: "1" }));
    const audit = await prisma.auditLog.findFirst({
      where: { action: "sign.hardware" },
    });
    expect(audit?.actorId).toBe("u1");
    expect(audit?.detail).toContain(`sign #${s.id}`);
    expect(audit?.detail).toContain("collected");
  });
});

describe("setHardwareReturned", () => {
  it("toggles equipmentReturned", async () => {
    const s = await seedSign({ itemId: "HR1", needsEasel: true });
    await setHardwareReturned(s.id, form({ returned: "1" }));
    expect(
      (await prisma.sign.findUnique({ where: { id: s.id } }))
        ?.equipmentReturned,
    ).toBe(true);

    await setHardwareReturned(s.id, form({ returned: "0" }));
    expect(
      (await prisma.sign.findUnique({ where: { id: s.id } }))
        ?.equipmentReturned,
    ).toBe(false);
  });

  it("writes a sign.hardware_return audit row so the single-sign path matches bulk (#78)", async () => {
    const s = await seedSign({ itemId: "HR2", needsEasel: true });
    await setHardwareReturned(s.id, form({ returned: "1" }));
    const audit = await prisma.auditLog.findFirst({
      where: { action: "sign.hardware_return" },
    });
    expect(audit?.actorId).toBe("u1");
    expect(audit?.detail).toContain(`sign #${s.id}`);
    expect(audit?.detail).toContain("returned");
  });

  it("redirects to the list with an error when the sign does not exist", async () => {
    const url = await captureRedirect(
      setHardwareReturned(999999, form({ returned: "1" })),
    );
    expect(url).toContain("/signs?error=");
  });
});

describe("updateSign / deleteSign", () => {
  it("edits fields without touching status", async () => {
    const s = await seedSign({ itemId: "S5", signText: "Old", status: "printed" });
    const url = await captureRedirect(
      updateSign(
        s.id,
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "S5",
          signText: "Updated",
          signType: "Sign",
          size: "24x36",
          quantity: "2",
        }),
      ),
    );
    expect(url).toBe(`/signs/${s.id}`);
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.signText).toBe("Updated");
    expect(after?.size).toBe("24x36");
    expect(after?.status).toBe("printed"); // unchanged by an edit
  });

  // A zone can be deactivated mid-con while signs still point at it. Editing an
  // unrelated field on such a sign must neither wipe the assignment nor block the
  // save — but the sign must not be able to MOVE onto an inactive zone.
  describe("a deactivated zone the sign already has", () => {
    // Zones are reference data — setup.ts preserves them across the per-test
    // TRUNCATE — so seed by upsert (zoneCode is unique) and clean up at the end,
    // or a re-run would collide and the leftovers would leak into other files.
    const TEST_ZONE_PREFIX = "TEST-OFF-";

    async function seedInactiveZone(zoneCode: string) {
      return prisma.zone.upsert({
        where: { zoneCode },
        create: { zoneCode, zoneName: "Retired", isActive: false },
        update: { isActive: false },
      });
    }

    afterAll(async () => {
      const where = { zone: { zoneCode: { startsWith: TEST_ZONE_PREFIX } } };
      await prisma.sign.deleteMany({ where });
      await prisma.zone.deleteMany({
        where: { zoneCode: { startsWith: TEST_ZONE_PREFIX } },
      });
    });

    it("survives an edit that changes only an unrelated field", async () => {
      const zone = await seedInactiveZone("TEST-OFF-1");
      const s = await seedSign({ itemId: "ZN1", zoneId: zone.id });

      const url = await captureRedirect(
        updateSign(
          s.id,
          EMPTY_SIGN_FORM_STATE,
          form({
            itemId: "ZN1",
            signText: "Renamed only",
            signType: "Sign",
            size: "22x28",
            quantity: "1",
            zoneId: String(zone.id),
          }),
        ),
      );

      expect(url).toBe(`/signs/${s.id}`);
      const after = await prisma.sign.findUnique({ where: { id: s.id } });
      expect(after?.zoneId).toBe(zone.id);
      expect(after?.signText).toBe("Renamed only");
    });

    it("can still be cleared to no zone", async () => {
      const zone = await seedInactiveZone("TEST-OFF-2");
      const s = await seedSign({ itemId: "ZN2", zoneId: zone.id });

      await captureRedirect(
        updateSign(
          s.id,
          EMPTY_SIGN_FORM_STATE,
          form({
            itemId: "ZN2",
            signText: "Seed",
            signType: "Sign",
            size: "22x28",
            quantity: "1",
            zoneId: "",
          }),
        ),
      );

      const after = await prisma.sign.findUnique({ where: { id: s.id } });
      expect(after?.zoneId).toBeNull();
    });

    it("is still refused as a NEW assignment on a sign that never had it", async () => {
      const zone = await seedInactiveZone("TEST-OFF-3");
      const s = await seedSign({ itemId: "ZN3" });

      const result = await updateSign(
        s.id,
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "ZN3",
          signText: "Seed",
          signType: "Sign",
          size: "22x28",
          quantity: "1",
          zoneId: String(zone.id),
        }),
      );

      expect(result.error).toBe("Selected zone is not available.");
      const after = await prisma.sign.findUnique({ where: { id: s.id } });
      expect(after?.zoneId).toBeNull();
    });

    it("is still refused on create", async () => {
      const zone = await seedInactiveZone("TEST-OFF-4");

      const result = await createSign(
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "ZN4",
          signText: "Seed",
          signType: "Sign",
          size: "22x28",
          quantity: "1",
          zoneId: String(zone.id),
        }),
      );

      expect(result.error).toBe("Selected zone is not available.");
      expect(await prisma.sign.count({ where: { itemId: "ZN4" } })).toBe(0);
    });
  });

  it("logs a reformat as a change_type='format' history row with old→new labels", async () => {
    // Seed the exact foamcore-22×28 tuple, then reformat to the foamcore-24×36 tuple.
    const s = await seedSign({
      itemId: "FMT1",
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
    });
    await captureRedirect(
      updateSign(
        s.id,
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "FMT1",
          signText: "Seed",
          signType: '24"x36"',
          size: "24x36",
          category: "easel_sign",
          quantity: "1",
        }),
      ),
    );
    const hist = await prisma.statusHistory.findMany({
      where: { signId: s.id, changeType: "format" },
    });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      changeType: "format",
      oldStatus: "Foamcore 22×28",
      newStatus: "Foamcore 24×36",
      changedBy: "lead@example.com",
    });
    // The sign.update audit spells out the format delta too.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "sign.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.detail).toContain("format Foamcore 22×28 → Foamcore 24×36");
  });

  it("writes NO format row when the edit changes no format field", async () => {
    const s = await seedSign({
      itemId: "FMT2",
      size: "22x28",
      signType: '22"x28"',
      category: "easel_sign",
      doubleSided: false,
    });
    await captureRedirect(
      updateSign(
        s.id,
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "FMT2",
          signText: "Renamed only",
          signType: '22"x28"',
          size: "22x28",
          category: "easel_sign",
          quantity: "1",
        }),
      ),
    );
    // No format field moved → no history row of any kind (updateSign never writes status).
    expect(
      await prisma.statusHistory.count({ where: { signId: s.id } }),
    ).toBe(0);
  });

  it("preserves the hidden master-sheet system tag across an edit", async () => {
    // The edit form hides system tags, so they're never resubmitted; the wholesale
    // tag-replace must NOT strip them (that would drop the sign out of reconcile).
    const [masterSheet, village] = await Promise.all([
      prisma.signTag.findUniqueOrThrow({ where: { slug: "master-sheet" } }),
      prisma.signTag.findUniqueOrThrow({ where: { slug: "village" } }),
    ]);
    const s = await prisma.sign.create({
      data: {
        itemId: "MS1",
        signText: "Cloud Village",
        sheetName: "Cloud Village",
        signType: "Sign",
        size: "22x28",
        tagAssignments: {
          create: [{ tagId: masterSheet.id }, { tagId: village.id }],
        },
      },
    });

    await captureRedirect(
      updateSign(
        s.id,
        EMPTY_SIGN_FORM_STATE,
        form({
          itemId: "MS1",
          signText: "Renamed",
          signType: "Sign",
          size: "22x28",
          quantity: "1",
          tags: String(village.id), // only the user tag is resubmitted
        }),
      ),
    );

    const after = await prisma.signTagAssignment.findMany({
      where: { signId: s.id },
      include: { tag: true },
    });
    const slugs = after.map((a) => a.tag.slug);
    expect(slugs).toContain("master-sheet"); // preserved
    expect(slugs).toContain("village"); // resubmitted user tag stays
    const sign = await prisma.sign.findUniqueOrThrow({ where: { id: s.id } });
    expect(sign.signText).toBe("Renamed");
  });

  it("rejects setting a system tag (master-sheet) via the sign form", async () => {
    // The form hides system tags; a submitted system-tag id is a hand-crafted attempt
    // to pull a sign INTO reconcile scope. createSign + updateSign must both reject it.
    const ms = await prisma.signTag.findUniqueOrThrow({
      where: { slug: "master-sheet" },
    });

    // createSign/updateSign now return a typed { error } to the form instead of
    // redirecting, so assert on the returned state (not a captured redirect).
    const createResult = await createSign(
      EMPTY_SIGN_FORM_STATE,
      form({
        itemId: "SYS-C",
        signText: "Nope",
        signType: "Sign",
        size: "22x28",
        tags: String(ms.id),
      }),
    );
    expect(createResult.error).toBeTruthy();
    expect(await prisma.sign.count({ where: { itemId: "SYS-C" } })).toBe(0);

    const s = await seedSign({ itemId: "SYS-U" });
    const updateResult = await updateSign(
      s.id,
      EMPTY_SIGN_FORM_STATE,
      form({
        itemId: "SYS-U",
        signText: "Nope",
        signType: "Sign",
        size: "22x28",
        tags: String(ms.id),
      }),
    );
    expect(updateResult.error).toBeTruthy();
    expect(
      await prisma.signTagAssignment.count({
        where: { signId: s.id, tagId: ms.id },
      }),
    ).toBe(0);
  });

  it("deletes a sign", async () => {
    const s = await seedSign({ itemId: "S4" });
    const url = await captureRedirect(deleteSign(s.id));
    expect(url).toBe("/signs");
    expect(await prisma.sign.findUnique({ where: { id: s.id } })).toBeNull();

    // The audit names the item id, not just the row id (the row is gone, so the
    // detail string is the only way to tell WHAT was deleted).
    const audit = await prisma.auditLog.findFirst({
      where: { action: "sign.delete" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.detail).toContain("S4");
  });

  // #234: a double-submitted delete used to surface the same opaque error as a
  // real DB fault, and neither case left anything in the audit log.
  it("treats a duplicate/missing delete as a distinguishable no-op and audits it", async () => {
    const s = await seedSign({ itemId: "S4D" });
    await captureRedirect(deleteSign(s.id));

    const url = await captureRedirect(deleteSign(s.id));
    expect(url).toContain("/signs?error=");
    expect(decodeURIComponent(url)).toMatch(/no longer exists/i);

    const failed = await prisma.auditLog.findFirst({
      where: { action: "sign.delete_failed" },
      orderBy: { createdAt: "desc" },
    });
    expect(failed).not.toBeNull();
    expect(failed?.actorId).toBe("u1");
    expect(failed?.detail).toContain(`#${s.id}`);
    expect(failed?.detail).toMatch(/no such sign/i);
    // The successful delete is still logged exactly once — the no-op didn't
    // double-count it.
    expect(await prisma.auditLog.count({ where: { action: "sign.delete" } })).toBe(1);
  });
});

describe("authorization (real rbac runs over the mocked session)", () => {
  it("rejects a volunteer from a lead-only action", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "vol@example.com", isActive: true, role: "volunteer" },
    } as never);
    await expect(
      createSign(
        EMPTY_SIGN_FORM_STATE,
        form({ itemId: "V-1", signText: "Nope", signType: "Sign", size: "22x28" }),
      ),
    ).rejects.toThrow(/role/i);
    expect(await prisma.sign.count()).toBe(0);
  });
});
