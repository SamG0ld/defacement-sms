import { describe, it, expect } from "vitest";

import {
  assertSameOrigin,
  readJsonBody,
  MAX_JSON_BODY_BYTES,
} from "@/lib/deploy/api-guards";
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

// Stream `chunks` as a request body with full control over the declared
// Content-Length — including omitting it, which is what chunked transfer-encoding
// does and what the declared-length pre-check therefore cannot see.
function bodyReq(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): Request {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
  return {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body,
    json: async () => {
      throw new Error("req.json() must not be used — it buffers past the cap");
    },
  } as unknown as Request;
}

function textReq(text: string, headers: Record<string, string> = {}): Request {
  const bytes = new TextEncoder().encode(text);
  return bodyReq([bytes], {
    "content-length": String(bytes.byteLength),
    ...headers,
  });
}

// #239: readJsonBody called req.json() with no cap at all, so any active session
// could make the runtime buffer an arbitrarily large body before Zod ever saw
// its shape — inconsistent with the binary-upload routes on the same surface,
// which check Content-Length before buffering and again after.
describe("readJsonBody — request body size cap (#239)", () => {
  it("exports a cap with headroom over the largest contract-valid payload", () => {
    // The schema bounds are on CHARACTERS but this cap is on BYTES: 200 deploy
    // events x 2000 chars of 3-byte CJK notes is ~1.2MB and still schema-legal
    // (lib/deploy/contract.ts), so the cap must clear that, not just the ~460KB
    // ASCII case — or it would 413 a valid floor batch.
    expect(MAX_JSON_BODY_BYTES).toBeGreaterThan(1.3 * 1024 * 1024);
    // ...but still meaningfully below Vercel's ~4.5MB platform ceiling.
    expect(MAX_JSON_BODY_BYTES).toBeLessThan(4 * 1024 * 1024);
  });

  it("accepts a max-size multi-byte (CJK) batch — chars vs bytes", async () => {
    // 200 events x 2000 CJK chars = 400k chars / ~1.2MB of UTF-8.
    const events = Array.from({ length: 200 }, (_, i) => ({
      clientId: `c${String(i).padStart(10, "0")}`,
      signId: i + 1,
      deployedAt: "2026-08-07T18:00:00.000Z",
      notes: "設".repeat(2000),
    }));
    const body = JSON.stringify({ events });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(1024 * 1024);
    const parsed = (await readJsonBody(textReq(body))) as { events: unknown[] };
    expect(parsed.events).toHaveLength(200);
  });

  it("rejects an oversized declared Content-Length with 413 (fast path)", async () => {
    const req = bodyReq([new Uint8Array(8)], {
      "content-length": String(MAX_JSON_BODY_BYTES + 1),
    });
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an oversized body with NO Content-Length (413)", async () => {
    const chunks = Array.from(
      { length: Math.ceil(MAX_JSON_BODY_BYTES / 65536) + 2 },
      () => new Uint8Array(65536),
    );
    await expect(readJsonBody(bodyReq(chunks))).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects an oversized body whose Content-Length understates it (413)", async () => {
    const chunks = Array.from(
      { length: Math.ceil(MAX_JSON_BODY_BYTES / 65536) + 2 },
      () => new Uint8Array(65536),
    );
    await expect(
      readJsonBody(bodyReq(chunks, { "content-length": "42" })),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("stops reading an oversized body instead of draining it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(65536)); // never closes
      },
    });
    const req = {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    } as unknown as Request;

    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBeLessThanOrEqual(
      Math.ceil(MAX_JSON_BODY_BYTES / 65536) + 3,
    );
  });

  it("still parses a realistic max-size batch (the cap must not break the floor)", async () => {
    // 200 status changes, each with the full 2000-char notes the contract allows.
    const changes = Array.from({ length: 200 }, (_, i) => ({
      signId: i + 1,
      status: "deployed",
      changedAt: "2026-08-07T18:00:00.000Z",
      notes: "n".repeat(2000),
    }));
    const parsed = (await readJsonBody(
      textReq(JSON.stringify({ changes })),
    )) as { changes: unknown[] };
    expect(parsed.changes).toHaveLength(200);
  });

  it("still checks content-type BEFORE spending anything on the body", async () => {
    const req = bodyReq([new Uint8Array(8)], { "content-type": "text/plain" });
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 415 });
  });
});

// #201/#213: req.json() threw a raw SyntaxError, which runApi's catch (which
// only special-cases ApiError and ZodError) turned into a generic 500 — so a
// truncated outbox replay from a flaky floor connection looked like a server
// bug in Sentry, and the client's retry logic treats 500 as retryable and would
// loop on a request that can never succeed.
describe("readJsonBody — malformed JSON is a 400, not a 500 (#201/#213)", () => {
  it("throws ApiError(400) for a syntactically invalid body", async () => {
    await expect(readJsonBody(textReq("{not json"))).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(readJsonBody(textReq("{not json"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 400 for a truncated body (bytes dropped mid-request)", async () => {
    await expect(
      readJsonBody(textReq('{"changes":[{"signId":1,')),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 for an empty body", async () => {
    await expect(readJsonBody(textReq(""))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 400 for a null body (a POST with no payload at all)", async () => {
    const req = {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    } as unknown as Request;
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 400 });
  });

  it("never leaks the raw parser message to the caller", async () => {
    try {
      await readJsonBody(textReq("{not json"));
      expect.unreachable("expected a throw");
    } catch (err) {
      expect((err as ApiError).message).toBe("invalid JSON body");
      expect((err as ApiError).message).not.toMatch(/position|token|JSON\.parse/i);
    }
  });

  it("still parses valid JSON of every top-level shape", async () => {
    await expect(readJsonBody(textReq('{"ok":1}'))).resolves.toEqual({ ok: 1 });
    await expect(readJsonBody(textReq("[1,2]"))).resolves.toEqual([1, 2]);
    await expect(readJsonBody(textReq("null"))).resolves.toBeNull();
  });

  it("decodes a multi-byte UTF-8 body correctly across chunk boundaries", async () => {
    // "é" is two bytes; splitting mid-character must not corrupt it.
    const full = new TextEncoder().encode('{"name":"café"}');
    const split = full.indexOf(0xc3); // first byte of "é"
    const req = bodyReq([full.slice(0, split + 1), full.slice(split + 1)]);
    await expect(readJsonBody(req)).resolves.toEqual({ name: "café" });
  });
});
