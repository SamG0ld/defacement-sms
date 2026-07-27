import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #106 (Site C): POST /api/signs/[id]/preview uploads a blob, then writes the
// pathname to the sign. If that DB write fails, the just-uploaded blob must be
// deleted so a failed replace doesn't orphan paid storage. Mock the blob layer +
// Prisma so we can force the write to throw and assert the compensating delete.
vi.mock("@/lib/rbac", () => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {
    actual?: string;
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: { sign: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/blob-image", () => ({
  putPrivateImage: vi.fn(),
  deletePrivateImage: vi.fn(),
  streamPrivateImage: vi.fn(),
}));
vi.mock("@/lib/image-upload", () => ({
  validateImageUpload: vi.fn(),
  MAX_IMAGE_BYTES: 10 * 1024 * 1024,
}));
vi.mock("@/lib/ratelimit", () => ({ checkMutationRateLimit: vi.fn() }));

import { prisma } from "@/lib/db";
import { putPrivateImage, deletePrivateImage } from "@/lib/blob-image";
import { validateImageUpload } from "@/lib/image-upload";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { requireRole } from "@/lib/rbac";
import { DELETE, POST } from "@/app/api/signs/[id]/preview/route";
import { routeParams } from "../helpers/route-params";

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ user: { id: "u1", role: "lead" } } as never);
  vi.mocked(prisma.sign.findUnique).mockResolvedValue({ previewImagePath: null } as never);
  vi.mocked(validateImageUpload).mockReturnValue({
    ok: true,
    image: { contentType: "image/png" },
  } as never);
  vi.mocked(putPrivateImage).mockResolvedValue("sign-previews/7-xyz.png");
  vi.mocked(checkMutationRateLimit).mockResolvedValue({
    success: true,
    remaining: 59,
    reset: 0,
  });
});
afterEach(() => vi.clearAllMocks());

function post(id: string) {
  const req = new Request(`http://localhost/api/signs/${id}/preview`, {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
  });
  return POST(req, { params: routeParams({ id }) });
}

function del(id: string) {
  const req = new Request(`http://localhost/api/signs/${id}/preview`, {
    method: "DELETE",
  });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("POST /api/signs/[id]/preview — blob orphan compensation (#106)", () => {
  it("deletes the just-uploaded blob when the DB update fails", async () => {
    vi.mocked(prisma.sign.update).mockRejectedValueOnce(new Error("db down"));
    await expect(post("7")).rejects.toThrow("db down");
    expect(deletePrivateImage).toHaveBeenCalledWith("sign-previews/7-xyz.png");
  });

  it("does not delete the new blob on a successful write", async () => {
    vi.mocked(prisma.sign.update).mockResolvedValueOnce({} as never);
    const res = await post("7");
    expect(res.status).toBe(200);
    expect(deletePrivateImage).not.toHaveBeenCalled();
  });
});

// #182: this route was the sole mutating endpoint with no per-actor limiter, so
// a hot loop could tie up the max:3 pg pool and run up Blob PUT/DELETE volume.
describe("/api/signs/[id]/preview — per-actor mutation rate limit (#182)", () => {
  const OVER_BUDGET = { success: false, remaining: 0, reset: 0 };

  it("POST returns 429 without touching Blob or the DB when over budget", async () => {
    vi.mocked(checkMutationRateLimit).mockResolvedValueOnce(OVER_BUDGET);
    const res = await post("7");
    expect(res.status).toBe(429);
    expect(checkMutationRateLimit).toHaveBeenCalledWith("u1");
    expect(prisma.sign.findUnique).not.toHaveBeenCalled();
    expect(putPrivateImage).not.toHaveBeenCalled();
    expect(prisma.sign.update).not.toHaveBeenCalled();
  });

  it("DELETE returns 429 without touching Blob or the DB when over budget", async () => {
    vi.mocked(checkMutationRateLimit).mockResolvedValueOnce(OVER_BUDGET);
    const res = await del("7");
    expect(res.status).toBe(429);
    expect(prisma.sign.findUnique).not.toHaveBeenCalled();
    expect(deletePrivateImage).not.toHaveBeenCalled();
  });

  it("DELETE proceeds normally when within budget", async () => {
    vi.mocked(prisma.sign.findUnique).mockResolvedValueOnce({
      previewImagePath: "sign-previews/7-old.png",
    } as never);
    vi.mocked(prisma.sign.update).mockResolvedValueOnce({} as never);
    const res = await del("7");
    expect(res.status).toBe(200);
    expect(deletePrivateImage).toHaveBeenCalledWith("sign-previews/7-old.png");
  });
});
