import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #106 (Site B): POST /api/native/deploys/[clientId]/photo uploads a blob, then
// attaches the URL via attachDeployPhoto. If the attach throws, or the deploy event
// vanished (attach returns null → 404), the uploaded blob must be deleted so a
// failed attach can't orphan paid storage. We stub the api-session harness (so the
// route runs without NextAuth) and the blob/service seams, then assert the cleanup.
vi.mock("@/lib/deploy/api-session", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    apiError: (status: number, message: string) =>
      Response.json({ error: message }, { status }),
    requireApiSession: vi.fn(async () => ({
      userId: "u1",
      email: "u1@example.com",
      role: "lead",
    })),
    runApi: async (_req: Request, fn: () => Promise<unknown>) => {
      try {
        return Response.json(await fn());
      } catch (e) {
        if (e instanceof ApiError) {
          return Response.json({ error: e.message }, { status: e.status });
        }
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    },
  };
});
// The route uses real hasRole (@/lib/rbac), which imports @/lib/auth → next-auth →
// next/server (unresolvable in the node unit env). Mock auth + log to break that
// chain; hasRole itself stays real so the lead-bypass logic is genuinely exercised.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/log", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    deployEvent: { findUnique: vi.fn(), update: vi.fn() },
    sign: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/deploy/blob", () => ({
  uploadDeployPhoto: vi.fn(),
  streamDeployPhoto: vi.fn(),
  deleteDeployPhoto: vi.fn(),
}));
vi.mock("@/lib/deploy/service", () => ({ attachDeployPhoto: vi.fn() }));
vi.mock("@/lib/blob-image", () => ({ deletePrivateImage: vi.fn() }));
vi.mock("@/lib/image-upload", () => ({
  validateImageUpload: vi.fn(),
  MAX_IMAGE_BYTES: 10 * 1024 * 1024,
}));

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { uploadDeployPhoto, deleteDeployPhoto } from "@/lib/deploy/blob";
import { attachDeployPhoto } from "@/lib/deploy/service";
import { deletePrivateImage } from "@/lib/blob-image";
import { validateImageUpload } from "@/lib/image-upload";
import { POST } from "@/app/api/native/deploys/[clientId]/photo/route";
import { routeParams } from "../helpers/route-params";

beforeEach(() => {
  // A lead bypasses the ownership gate, so any non-null event passes the pre-checks.
  vi.mocked(prisma.deployEvent.findUnique).mockResolvedValue({
    deployedByUserId: "owner",
  } as never);
  vi.mocked(validateImageUpload).mockReturnValue({
    ok: true,
    image: { contentType: "image/png" },
  } as never);
  vi.mocked(uploadDeployPhoto).mockResolvedValue("deploy-photos/c1-xyz.png");
});
afterEach(() => vi.clearAllMocks());

function post(clientId: string) {
  const req = new Request(
    `http://localhost/api/native/deploys/${clientId}/photo`,
    { method: "POST", body: new Uint8Array([1, 2, 3]) },
  );
  return POST(req, { params: routeParams({ clientId }) });
}

describe("POST /api/native/deploys/[clientId]/photo — blob orphan compensation (#106)", () => {
  it("deletes the uploaded blob when attachDeployPhoto throws", async () => {
    vi.mocked(attachDeployPhoto).mockRejectedValueOnce(new Error("tx failed"));
    const res = await post("c1");
    expect(res.status).toBe(500);
    expect(deletePrivateImage).toHaveBeenCalledWith("deploy-photos/c1-xyz.png");
  });

  it("deletes the uploaded blob when the deploy event vanished (attach → null → 404)", async () => {
    vi.mocked(attachDeployPhoto).mockResolvedValueOnce(null);
    const res = await post("c1");
    expect(res.status).toBe(404);
    expect(deletePrivateImage).toHaveBeenCalledWith("deploy-photos/c1-xyz.png");
  });

  it("does not delete the blob on a successful attach", async () => {
    vi.mocked(attachDeployPhoto).mockResolvedValueOnce({
      signId: 42,
      cachedOnSign: true,
    });
    const res = await post("c1");
    expect(res.status).toBe(200);
    expect(deletePrivateImage).not.toHaveBeenCalled();
  });

  // #231: a losing (conflict) deploy's photo is still kept on its DeployEvent for
  // the after-action log, but it is NOT the sign's photo — so the response must
  // hand back the event-scoped URL and tell the client not to cache it on the sign.
  it("returns the sign-scoped URL when the photo was cached on the sign", async () => {
    vi.mocked(attachDeployPhoto).mockResolvedValueOnce({
      signId: 42,
      cachedOnSign: true,
    });
    const res = await post("c1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientId: "c1",
      photoUrl: "/api/native/photos/sign/42",
      cachedOnSign: true,
    });
  });

  it("returns the event-scoped URL for a conflict event (no sign cache write)", async () => {
    vi.mocked(attachDeployPhoto).mockResolvedValueOnce({
      signId: 42,
      cachedOnSign: false,
    });
    const res = await post("c1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientId: "c1",
      photoUrl: "/api/native/deploys/c1/photo",
      cachedOnSign: false,
    });
    // The photo is kept, so the blob must NOT be reclaimed.
    expect(deletePrivateImage).not.toHaveBeenCalled();
  });
});

// #127: attachDeployPhoto itself is mocked wholesale above (for the route-level
// tests), so exercise the REAL implementation here via importActual — the mocked
// prisma/blob seams stay in effect, only the attach function under test is real.
describe("attachDeployPhoto — reclaims the replaced blob(s) on a photo re-take (#127)", () => {
  async function loadReal() {
    const mod = await vi.importActual<typeof import("@/lib/deploy/service")>(
      "@/lib/deploy/service",
    );
    return mod.attachDeployPhoto;
  }

  it("deletes the old blob exactly once when event and sign agree (the common case), never the new one", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: "deploy-photos/old.png",
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: "deploy-photos/old.png",
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    const res = await realAttachDeployPhoto("c1", "deploy-photos/new.png");

    expect(res).toEqual({ signId: 42, cachedOnSign: true });
    expect(deleteDeployPhoto).toHaveBeenCalledTimes(1);
    expect(deleteDeployPhoto).toHaveBeenCalledWith("deploy-photos/old.png");
    expect(deleteDeployPhoto).not.toHaveBeenCalledWith("deploy-photos/new.png");
  });

  it("deletes each distinct old pathname when the event and sign disagree", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: "deploy-photos/event-old.png",
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: "deploy-photos/sign-old.png",
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    await realAttachDeployPhoto("c1", "deploy-photos/new.png");

    expect(deleteDeployPhoto).toHaveBeenCalledTimes(2);
    expect(deleteDeployPhoto).toHaveBeenCalledWith("deploy-photos/event-old.png");
    expect(deleteDeployPhoto).toHaveBeenCalledWith("deploy-photos/sign-old.png");
  });

  it("does not delete anything on a first attach (event and sign both null)", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: null,
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: null,
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    await realAttachDeployPhoto("c1", "deploy-photos/new.png");

    expect(deleteDeployPhoto).not.toHaveBeenCalled();
  });

  it("does not delete when the old and new pathname are identical", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: "deploy-photos/same.png",
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: "deploy-photos/same.png",
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    await realAttachDeployPhoto("c1", "deploy-photos/same.png");

    expect(deleteDeployPhoto).not.toHaveBeenCalled();
  });
});

// #231: applyDeploys can write MORE than one DeployEvent per sign — the first is
// `applied` (it set Sign.status=deployed), any later one is `conflict`. A conflict
// event's photo must never become the sign's cached photo, and must never cause
// the winner's blob to be reclaimed.
describe("attachDeployPhoto — only the winning deploy's photo caches on the Sign (#231)", () => {
  async function loadReal() {
    const mod = await vi.importActual<typeof import("@/lib/deploy/service")>(
      "@/lib/deploy/service",
    );
    return mod.attachDeployPhoto;
  }

  function mockEvent(status: string, photoUrl: string | null = null) {
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status,
      photoUrl,
    } as never);
  }

  it("a conflict event attaches to the DeployEvent but never touches the Sign", async () => {
    const realAttachDeployPhoto = await loadReal();
    mockEvent("conflict");
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    const res = await realAttachDeployPhoto("loser", "deploy-photos/loser.png");

    expect(res).toEqual({ signId: 42, cachedOnSign: false });
    // The sign's cached URL is only needed to decide what to reclaim, which a
    // losing event never does — so it isn't even read.
    expect(prisma.sign.findUnique).not.toHaveBeenCalled();
    expect(prisma.deployEvent.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { photoUrl: "deploy-photos/loser.png" },
    });
    expect(prisma.sign.update).not.toHaveBeenCalled();
  });

  it("a conflict event never reclaims the winner's blob", async () => {
    const realAttachDeployPhoto = await loadReal();
    mockEvent("conflict");
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    await realAttachDeployPhoto("loser", "deploy-photos/loser.png");

    expect(deleteDeployPhoto).not.toHaveBeenCalled();
  });

  it("a conflict RE-take still reclaims that losing event's own previous blob", async () => {
    // The losing crew replacing their own photo is a normal retake — their old
    // blob has no DB reference left, so it must still be reclaimed. Only the
    // sign's (winning) pathname is off limits.
    const realAttachDeployPhoto = await loadReal();
    mockEvent("conflict", "deploy-photos/loser-old.png");
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    await realAttachDeployPhoto("loser", "deploy-photos/loser-new.png");

    expect(deleteDeployPhoto).toHaveBeenCalledTimes(1);
    expect(deleteDeployPhoto).toHaveBeenCalledWith("deploy-photos/loser-old.png");
    expect(deleteDeployPhoto).not.toHaveBeenCalledWith("deploy-photos/winner.png");
  });

  it("an applied event still caches on the Sign (the winning path is unchanged)", async () => {
    const realAttachDeployPhoto = await loadReal();
    mockEvent("applied");
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: null,
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([] as never);

    const res = await realAttachDeployPhoto("winner", "deploy-photos/new.png");

    expect(res).toEqual({ signId: 42, cachedOnSign: true });
    expect(prisma.sign.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { deployPhotoUrl: "deploy-photos/new.png" },
    });
  });
});

// #212: the sign can be hard-deleted between the reads and the transaction. The
// whole tx rolls back (nothing partial commits), so this is a clean, expected
// 404 — not an unhandled 500 that pages on-call for a benign race.
describe("attachDeployPhoto — sign deleted mid-flight (#212)", () => {
  async function loadReal() {
    const mod = await vi.importActual<typeof import("@/lib/deploy/service")>(
      "@/lib/deploy/service",
    );
    return mod.attachDeployPhoto;
  }

  function p2025() {
    return new Prisma.PrismaClientKnownRequestError("record not found", {
      code: "P2025",
      clientVersion: "test",
    });
  }

  it("returns null when the sign vanished, so the route 404s and reclaims the blob", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: null,
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: null,
    } as never);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(p2025());

    const res = await realAttachDeployPhoto("c1", "deploy-photos/new.png");

    expect(res).toBeNull();
    // The tx rolled back, so there is no committed reference to reclaim against —
    // the route deletes the just-uploaded blob on the null branch.
    expect(deleteDeployPhoto).not.toHaveBeenCalled();
  });

  it("still rethrows a non-P2025 database error", async () => {
    const realAttachDeployPhoto = await loadReal();
    vi.mocked(prisma.deployEvent.findUnique).mockResolvedValueOnce({
      id: 1,
      signId: 42,
      status: "applied",
      photoUrl: null,
    } as never);
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      deployPhotoUrl: null,
    } as never);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("pool exhausted"));

    await expect(
      realAttachDeployPhoto("c1", "deploy-photos/new.png"),
    ).rejects.toThrow(/pool exhausted/);
  });
});
