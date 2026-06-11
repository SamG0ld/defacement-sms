import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  updateSign,
  updateSignStatus,
} from "@/app/(app)/signs/actions";

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
});

describe("updateSign / deleteSign", () => {
  it("edits fields without touching status", async () => {
    const s = await seedSign({ itemId: "S5", signText: "Old", status: "printed" });
    const url = await captureRedirect(
      updateSign(
        s.id,
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

  it("deletes a sign", async () => {
    const s = await seedSign({ itemId: "S4" });
    const url = await captureRedirect(deleteSign(s.id));
    expect(url).toBe("/signs");
    expect(await prisma.sign.findUnique({ where: { id: s.id } })).toBeNull();
  });
});

describe("authorization (real rbac runs over the mocked session)", () => {
  it("rejects a volunteer from a lead-only action", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "v1", email: "vol@example.com", isActive: true, role: "volunteer" },
    } as never);
    await expect(
      createSign(
        form({ itemId: "V-1", signText: "Nope", signType: "Sign", size: "22x28" }),
      ),
    ).rejects.toThrow(/role/i);
    expect(await prisma.sign.count()).toBe(0);
  });
});
