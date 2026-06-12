import { describe, it, expect } from "vitest";

import { assertSameOrigin, readJsonBody } from "@/lib/deploy/api-guards";
import { ApiError } from "@/lib/deploy/api-types";

// assertSameOrigin only touches req.method + req.headers.get, so a minimal
// stand-in avoids undici's forbidden-header filtering (a constructed Request
// may silently drop `host`).
function fakeReq(method: string, headers: Record<string, string>): Request {
  return { method, headers: new Headers(headers) } as unknown as Request;
}

function expectRejected(req: Request): void {
  try {
    assertSameOrigin(req);
    expect.unreachable("expected assertSameOrigin to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  }
}

describe("assertSameOrigin — CSRF guard", () => {
  it("passes a same-origin fetch (Sec-Fetch-Site: same-origin)", () => {
    expect(() =>
      assertSameOrigin(
        fakeReq("POST", {
          "sec-fetch-site": "same-origin",
          origin: "https://app.example.com",
          host: "app.example.com",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a cross-site POST by Sec-Fetch-Site alone", () => {
    expectRejected(fakeReq("POST", { "sec-fetch-site": "cross-site" }));
    expectRejected(fakeReq("POST", { "sec-fetch-site": "same-site" }));
    expectRejected(fakeReq("POST", { "sec-fetch-site": "none" }));
  });

  it("rejects an Origin that doesn't match the host (older browsers, no Sec-Fetch)", () => {
    expectRejected(
      fakeReq("POST", {
        origin: "https://evil.example.org",
        host: "app.example.com",
      }),
    );
  });

  it("passes an Origin matching the host", () => {
    expect(() =>
      assertSameOrigin(
        fakeReq("POST", {
          origin: "https://app.example.com",
          host: "app.example.com",
        }),
      ),
    ).not.toThrow();
  });

  it("prefers x-forwarded-host when a proxy rewrote Host", () => {
    expect(() =>
      assertSameOrigin(
        fakeReq("POST", {
          origin: "https://public.example.com",
          "x-forwarded-host": "public.example.com",
          host: "internal-upstream:3000",
        }),
      ),
    ).not.toThrow();
    expectRejected(
      fakeReq("POST", {
        origin: "https://evil.example.org",
        "x-forwarded-host": "public.example.com",
        host: "internal-upstream:3000",
      }),
    );
  });

  it("rejects an unparseable Origin", () => {
    expectRejected(fakeReq("POST", { origin: "null", host: "app.example.com" }));
  });

  it("passes a non-browser request with neither header (curl / future bearer client)", () => {
    expect(() =>
      assertSameOrigin(fakeReq("POST", { host: "app.example.com" })),
    ).not.toThrow();
  });

  it("never blocks reads (GET/HEAD/OPTIONS)", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(() =>
        assertSameOrigin(fakeReq(method, { "sec-fetch-site": "cross-site" })),
      ).not.toThrow();
    }
  });
});

describe("readJsonBody — content-type belt", () => {
  it("parses an application/json body (with or without charset)", async () => {
    for (const ct of ["application/json", "application/json; charset=utf-8"]) {
      const req = new Request("https://app.example.com/api/native/x", {
        method: "POST",
        headers: { "content-type": ct },
        body: JSON.stringify({ ok: 1 }),
      });
      await expect(readJsonBody(req)).resolves.toEqual({ ok: 1 });
    }
  });

  it("rejects text/plain (the cross-site form smuggle) with 415", async () => {
    const req = new Request("https://app.example.com/api/native/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ ok: 1 }),
    });
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 415 });
  });

  it("rejects a missing content type with 415", async () => {
    const req = {
      method: "POST",
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Request;
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 415 });
  });
});
