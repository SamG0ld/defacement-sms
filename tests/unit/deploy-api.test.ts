import { describe, it, expect, vi, afterEach } from "vitest";

import {
  ApiHttpError,
  NetworkError,
  getBootstrap,
  leaveCrew,
} from "@/app/(app)/deploy/_lib/api";

// A minimal stand-in for the fetch Response shape `request()` actually touches.
function fakeResponse(init: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? "",
    json: init.json ?? (async () => ({})),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiHttpError.permanent — dead-letter vs retry classification", () => {
  it("is permanent for ordinary 4xx (malformed/forbidden — replay can't help)", () => {
    for (const status of [400, 403, 404, 422]) {
      expect(new ApiHttpError(status, "x").permanent).toBe(true);
    }
  });

  it("is NOT permanent for 401 (auth-expiry — succeeds after re-login)", () => {
    expect(new ApiHttpError(401, "x").permanent).toBe(false);
  });

  it("is NOT permanent for 429 (rate-limited — worth retrying)", () => {
    expect(new ApiHttpError(429, "x").permanent).toBe(false);
  });

  it("is NOT permanent for 5xx (server hiccup — worth retrying)", () => {
    for (const status of [500, 502, 503]) {
      expect(new ApiHttpError(status, "x").permanent).toBe(false);
    }
  });
});

describe("request() error + body handling", () => {
  it("throws NetworkError when fetch rejects (offline / DNS / CORS)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(getBootstrap()).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws ApiHttpError carrying the parsed body.error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: async () => ({ error: "you can't do that" }),
        }),
      ),
    );
    await expect(getBootstrap()).rejects.toMatchObject({
      status: 403,
      message: "you can't do that",
    });
  });

  it("falls back to statusText when the error body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: async () => {
            throw new Error("not json");
          },
        }),
      ),
    );
    await expect(getBootstrap()).rejects.toMatchObject({
      status: 500,
      message: "Server Error",
    });
  });

  it("returns undefined on 204 No Content (release/leave have no body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 204 })),
    );
    await expect(leaveCrew(1)).resolves.toBeUndefined();
  });
});
