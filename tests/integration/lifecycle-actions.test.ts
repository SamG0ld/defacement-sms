import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same request-context mocks as sign-actions.test.ts. Prisma is REAL. The Blob
// upload is mocked so the photo path never reaches Vercel — validateImageUpload
// (magic-byte check) stays real so we still exercise the real validation.
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
vi.mock("@/lib/sign-photos", () => ({
  uploadSignPhoto: vi.fn(async () => "sign-photos/fake-blob.png"),
  SIGN_PHOTO_KINDS: ["delivery", "handoff", "install"],
  streamSignPhoto: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uploadSignPhoto } from "@/lib/sign-photos";
import {
  confirmInstalled,
  recordDelivery,
  recordHandoff,
} from "@/app/(app)/signs/lifecycle-actions";

const session = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "admin" },
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session as never);
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

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// A minimal valid PNG header (mirrors tests/unit/image-upload.test.ts) so the real
// validateImageUpload accepts it; the upload itself is mocked.
function pngFile(): File {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, 100);
  new DataView(b.buffer).setUint32(20, 100);
  return new File([b], "photo.png", { type: "image/png" });
}

function seedExternal(over: Record<string, unknown> = {}) {
  return prisma.sign.create({
    data: {
      itemId: "EXT",
      signText: "Banner",
      signType: "Banner",
      size: "8'x20'",
      category: "union_installed",
      quantity: 5,
      status: "printed",
      ...over,
    },
  });
}

describe("recordDelivery", () => {
  it("sets delivered + received count/condition and writes history", async () => {
    const s = await seedExternal();
    await recordDelivery(
      s.id,
      fd({ receivedQty: "4", condition: "1 of 5 arrived creased" }),
    );

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("delivered");
    expect(after?.receivedQty).toBe(4);
    expect(after?.deliveryCondition).toBe("1 of 5 arrived creased");
    expect(after?.deliveredBy).toBe("lead@example.com");
    expect(after?.deliveredAt).not.toBeNull();

    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      oldStatus: "printed",
      newStatus: "delivered",
      changedBy: "lead@example.com",
    });
    expect(hist[0].notes).toContain("received 4");
  });

  it("stores a delivery photo pathname when a valid image is attached", async () => {
    const s = await seedExternal();
    const f = fd({ receivedQty: "5" });
    f.set("photo", pngFile());
    await recordDelivery(s.id, f);

    expect(uploadSignPhoto).toHaveBeenCalledWith(
      s.id,
      "delivery",
      expect.any(Uint8Array),
      "image/png",
    );
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.deliveryPhotoUrl).toBe("sign-photos/fake-blob.png");
  });

  it("refuses to re-record delivery after the item is handed off", async () => {
    const s = await seedExternal({
      status: "handed_off",
      deliveredBy: "earlier@example.com",
      deliveredAt: new Date("2026-06-01T00:00:00Z"),
      handedOffTo: "Union Local 720",
    });
    const url = await captureRedirect(
      recordDelivery(s.id, fd({ receivedQty: "9", condition: "tampered" })),
    );
    expect(url).toContain("error=");
    // Backward overwrite blocked: status + delivery stamps untouched, no history.
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("handed_off");
    expect(after?.deliveredBy).toBe("earlier@example.com");
    expect(after?.receivedQty).toBeNull();
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(0);
  });
});

describe("recordHandoff", () => {
  it("sets handed_off + recipient and writes history", async () => {
    const s = await seedExternal({ status: "delivered" });
    await recordHandoff(
      s.id,
      fd({ handedOffTo: "Union Local 720 — Mike", notes: "dock B" }),
    );

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("handed_off");
    expect(after?.handedOffTo).toBe("Union Local 720 — Mike");
    expect(after?.handedOffBy).toBe("lead@example.com");
    expect(after?.handedOffAt).not.toBeNull();
    expect(after?.handoffNotes).toBe("dock B");

    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist[0]?.notes).toContain("Union Local 720");
  });

  it("rejects a handoff with no recipient and leaves status unchanged", async () => {
    const s = await seedExternal({ status: "delivered" });
    const url = await captureRedirect(recordHandoff(s.id, fd({ handedOffTo: "" })));
    expect(url).toContain("error=");
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("delivered");
    expect(after?.handedOffAt).toBeNull();
  });

  it("refuses to re-record handoff after the item is installed", async () => {
    const s = await seedExternal({
      status: "installed",
      handedOffTo: "Union Local 720 — Mike",
      installedBy: "earlier@example.com",
    });
    const url = await captureRedirect(
      recordHandoff(s.id, fd({ handedOffTo: "Someone Else" })),
    );
    expect(url).toContain("error=");
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("installed");
    expect(after?.handedOffTo).toBe("Union Local 720 — Mike");
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(0);
  });
});

describe("confirmInstalled", () => {
  it("sets installed + stamps and writes history", async () => {
    const s = await seedExternal({ status: "handed_off" });
    await confirmInstalled(s.id, fd({ notes: "up on the SE wall" }));

    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("installed");
    expect(after?.installedBy).toBe("lead@example.com");
    expect(after?.installedAt).not.toBeNull();
    expect(after?.installNotes).toBe("up on the SE wall");
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist[0]?.notes).toContain("SE wall");
  });

  it("stores an install photo pathname when a valid image is attached", async () => {
    const s = await seedExternal({ status: "handed_off" });
    const f = fd({ notes: "up on the SE wall" });
    f.set("photo", pngFile());
    await confirmInstalled(s.id, f);

    expect(uploadSignPhoto).toHaveBeenCalledWith(
      s.id,
      "install",
      expect.any(Uint8Array),
      "image/png",
    );
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.installPhotoUrl).toBe("sign-photos/fake-blob.png");
  });

  it("refuses a duplicate confirm — stamps survive, no noise history row", async () => {
    const s = await seedExternal({
      status: "installed",
      installedBy: "earlier@example.com",
      installNotes: "original install note",
    });
    const url = await captureRedirect(
      confirmInstalled(s.id, fd({ notes: "second confirm" })),
    );
    expect(url).toContain("error=");
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.installedBy).toBe("earlier@example.com");
    expect(after?.installNotes).toBe("original install note");
    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(0);
  });
});

describe("external-category guard", () => {
  it("rejects a lifecycle action on a non-external sign", async () => {
    const s = await prisma.sign.create({
      data: {
        itemId: "EASEL",
        signText: "Poster",
        signType: "Sign",
        size: "22x28",
        category: "easel_sign",
        status: "printed",
      },
    });
    const url = await captureRedirect(
      recordHandoff(s.id, fd({ handedOffTo: "someone" })),
    );
    expect(url).toContain("error=");
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("printed"); // untouched
    expect(after?.handedOffAt).toBeNull();
  });
});

describe("full external lifecycle preserves earlier stamps", () => {
  it("delivery → handoff → install keeps deliveredAt + handedOffAt set", async () => {
    const s = await seedExternal();
    await recordDelivery(s.id, fd({ receivedQty: "5" }));
    const delAt = (await prisma.sign.findUnique({ where: { id: s.id } }))
      ?.deliveredAt;
    expect(delAt).not.toBeNull();

    await recordHandoff(s.id, fd({ handedOffTo: "NOC dispatch" }));
    const handAt = (await prisma.sign.findUnique({ where: { id: s.id } }))
      ?.handedOffAt;
    expect(handAt).not.toBeNull();

    await confirmInstalled(s.id, fd({}));
    const after = await prisma.sign.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe("installed");
    // Earlier steps rank below installed → absent from the patch → preserved.
    expect(after?.deliveredAt).toEqual(delAt);
    expect(after?.handedOffAt).toEqual(handAt);
    expect(after?.installedAt).not.toBeNull();

    const hist = await prisma.statusHistory.findMany({ where: { signId: s.id } });
    expect(hist).toHaveLength(3);
  });
});
