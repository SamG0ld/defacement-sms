import { afterEach, describe, expect, it, vi } from "vitest";

// #71: the private-Blob storage layer was untested — the 304 conditional path, the
// 502 exception path, and whether a missing blob throws or returns null all depend
// on @vercel/blob SDK behavior that an upgrade can silently change. Mock the SDK and
// pin the contract (incl. that puts are always private + random-suffixed).
vi.mock("@vercel/blob", () => ({ put: vi.fn(), get: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/log", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { put, get, del } from "@vercel/blob";
import { logError } from "@/lib/log";
import {
  putPrivateImage,
  deletePrivateImage,
  streamPrivateImage,
} from "@/lib/blob-image";

const putMock = vi.mocked(put);
const getMock = vi.mocked(get);
const delMock = vi.mocked(del);
const logErrorMock = vi.mocked(logError);

afterEach(() => vi.clearAllMocks());

describe("putPrivateImage", () => {
  it("stores privately with a random suffix and the given content type", async () => {
    putMock.mockResolvedValueOnce({ pathname: "sign-previews/42.png" } as never);

    const path = await putPrivateImage(
      "sign-previews",
      "42",
      new Uint8Array([1, 2, 3]),
      "image/png",
    );

    expect(path).toBe("sign-previews/42.png");
    const [key, body, opts] = putMock.mock.calls[0];
    expect(key).toBe("sign-previews/42.png");
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(opts).toMatchObject({
      access: "private",
      addRandomSuffix: true,
      contentType: "image/png",
    });
  });

  it("sanitizes the id and falls back to .bin for an unknown content type", async () => {
    putMock.mockResolvedValueOnce({ pathname: "x" } as never);
    await putPrivateImage("deploy-photos", "a/b*c", new Uint8Array([0]), "application/octet-stream");
    expect(putMock.mock.calls[0][0]).toBe("deploy-photos/abc.bin");
  });
});

describe("deletePrivateImage", () => {
  it("swallows a del() failure (logs, never throws)", async () => {
    delMock.mockRejectedValueOnce(new Error("blob gone"));
    await expect(deletePrivateImage("sign-previews/42.png")).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith("blob.delete-failed", expect.any(Error), {
      blobPathname: "sign-previews/42.png",
    });
  });
});

describe("streamPrivateImage", () => {
  it("returns 404 when the blob is missing (get returns null)", async () => {
    getMock.mockResolvedValueOnce(null as never);
    const res = await streamPrivateImage("p", null);
    expect(res.status).toBe(404);
  });

  it("returns 502 (and logs) when get() throws", async () => {
    getMock.mockRejectedValueOnce(new Error("upstream"));
    const res = await streamPrivateImage("p", null);
    expect(res.status).toBe(502);
    expect(logErrorMock).toHaveBeenCalledWith("blob.get-failed", expect.any(Error), {
      blobPathname: "p",
    });
  });

  it("returns 304 echoing the blob's ETag when not modified", async () => {
    getMock.mockResolvedValueOnce({ statusCode: 304, blob: { etag: '"v2"' } } as never);
    const res = await streamPrivateImage("p", '"v1"');
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"v2"');
  });

  it("falls back to the request ETag on a 304 with no blob", async () => {
    getMock.mockResolvedValueOnce({ statusCode: 304 } as never);
    const res = await streamPrivateImage("p", '"v1"');
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"v1"');
  });

  it("streams 200 with content type, nosniff, and the ETag", async () => {
    getMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: null,
      blob: { contentType: "image/png", etag: '"v3"' },
    } as never);
    const res = await streamPrivateImage("p", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("ETag")).toBe('"v3"');
  });
});
