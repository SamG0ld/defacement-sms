import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #200: /api/csp-report is the one truly public, unauthenticated route in the
// app (proxy.ts allowlists it). It declared a 32KB cap but reached it by
// calling req.text() FIRST — so a POST with an absent/false Content-Length and a
// multi-MB body was fully buffered into memory before the check rejected it.
// Mock the limiter so these run without Upstash.
vi.mock("@/lib/ratelimit", () => ({
  checkActionRateLimit: vi.fn(),
}));

import { checkActionRateLimit } from "@/lib/ratelimit";
import { POST } from "@/app/api/csp-report/route";

const MAX_REPORT_BYTES = 32 * 1024;
const limiter = vi.mocked(checkActionRateLimit);

// Build a Request whose body streams `chunks`, with full control over the
// declared Content-Length — including omitting it entirely (chunked encoding),
// which is exactly the case the old pre-check couldn't see.
function reqWithBody(
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
    headers: new Headers(headers),
    body,
    text: async () => {
      throw new Error("req.text() must not be used — it buffers past the cap");
    },
  } as unknown as Request;
}

function jsonReq(value: unknown, headers: Record<string, string> = {}): Request {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return reqWithBody([bytes], {
    "content-length": String(bytes.byteLength),
    ...headers,
  });
}

beforeEach(() => {
  limiter.mockResolvedValue({ success: true } as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/csp-report", () => {
  it("accepts a well-formed report-uri body with 204", async () => {
    const res = await POST(
      jsonReq({ "csp-report": { "violated-directive": "script-src" } }),
    );
    expect(res.status).toBe(204);
  });

  it("accepts a report-to array body with 204", async () => {
    const res = await POST(
      jsonReq([{ type: "csp-violation", body: { blockedURL: "https://evil" } }]),
    );
    expect(res.status).toBe(204);
  });

  it("silently drops (204) when the per-IP limiter is over budget", async () => {
    limiter.mockResolvedValue({ success: false } as never);
    const res = await POST(jsonReq({ "csp-report": {} }));
    expect(res.status).toBe(204);
  });

  it("keys the limiter in its own csp: namespace, never the auth bucket", async () => {
    await POST(jsonReq({ "csp-report": {} }, { "x-forwarded-for": "203.0.113.9" }));
    expect(limiter).toHaveBeenCalledWith("csp:203.0.113.9");
  });

  it("rejects an oversized declared Content-Length with 413 (fast path)", async () => {
    const res = await POST(
      reqWithBody([new Uint8Array(8)], {
        "content-length": String(MAX_REPORT_BYTES + 1),
      }),
    );
    expect(res.status).toBe(413);
  });

  // The #200 fix. Content-Length is attacker-controlled and simply absent under
  // chunked transfer-encoding, so it can never be the authoritative cap.
  it("rejects an oversized body with NO Content-Length at all (413)", async () => {
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(1024));
    const res = await POST(reqWithBody(chunks));
    expect(res.status).toBe(413);
  });

  it("rejects an oversized body whose Content-Length lies about being small (413)", async () => {
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(1024));
    const res = await POST(reqWithBody(chunks, { "content-length": "8" }));
    expect(res.status).toBe(413);
  });

  it("stops reading an oversized body instead of draining it (no full buffering)", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4096)); // never closes — an endless body
      },
    });
    const req = {
      method: "POST",
      headers: new Headers(),
      body,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(413);
    // 32KB cap / 4KB chunks = 9 pulls to cross it. A post-hoc check would have
    // looped forever (or until OOM) on this stream.
    expect(pulled).toBeLessThanOrEqual(12);
  });

  it("accepts a body sitting just under the cap", async () => {
    const filler = "x".repeat(MAX_REPORT_BYTES - 64);
    const res = await POST(jsonReq({ "csp-report": { note: filler } }));
    expect(res.status).toBe(204);
  });

  it("returns 204 (not 500) for an unparseable body", async () => {
    const res = await POST(
      reqWithBody([new TextEncoder().encode("{not json")], {
        "content-length": "9",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("returns 204 for an empty body", async () => {
    const res = await POST(reqWithBody([], { "content-length": "0" }));
    expect(res.status).toBe(204);
  });

  it("never echoes the report back in the response body", async () => {
    const res = await POST(jsonReq({ "csp-report": { secret: "canary-value" } }));
    await expect(res.text()).resolves.not.toContain("canary-value");
  });

  it("escapes the logged report so a crafted value can't forge log lines", async () => {
    const warn = vi.mocked(console.warn);
    await POST(jsonReq({ "csp-report": { d: "a\nlevel=fatal" } }));
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("");
    expect(logged).toContain("\\n");
    expect(logged).not.toContain("\nlevel=fatal");
  });
});
