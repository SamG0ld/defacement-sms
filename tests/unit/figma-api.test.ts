import { afterEach, describe, expect, it, vi } from "vitest";

// #70: the Figma REST client is the network edge for importer A and was entirely
// untested — a Figma response-shape change produced a silent `undefined` cascade
// rather than a thrown error. These stub `fetch` (no network) and pin the wire
// contract: response-shape handling, chunking, the SSRF guard, and the size cap.
import {
  fetchFileDocument,
  fetchNodeImages,
  fetchRenderedImage,
} from "@/lib/figma-api";

// A Figma render-bucket host that passes isAllowedImageHost (lib/figma).
const ALLOWED = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/render/x.png";

function res(init: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  /** Stream the body as these chunks instead of one `bytes` blob. */
  chunks?: Uint8Array[];
  headers?: Record<string, string>;
}): Response {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  // fetchRenderedImage streams res.body with an early abort (#250) rather than
  // calling the unbounded res.arrayBuffer(), so the stub has to expose a real
  // ReadableStream. arrayBuffer() stays for the other call paths.
  const chunks = init.chunks ?? (init.bytes ? [init.bytes] : []);
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
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => init.json ?? {},
    text: async () => "",
    body,
    arrayBuffer: async () => (init.bytes ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchFileDocument", () => {
  it("returns the .document on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ json: { document: { id: "0:0" } } })),
    );
    await expect(fetchFileDocument("KEY", "tok")).resolves.toEqual({ id: "0:0" });
  });

  it("throws when the response carries no document (shape change)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ json: {} })));
    await expect(fetchFileDocument("KEY", "tok")).rejects.toThrow(/no document/i);
  });

  it("throws a capped message on a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ ok: false, status: 404 })),
    );
    await expect(fetchFileDocument("KEY", "tok")).rejects.toThrow(/failed \(404\)/);
  });

  it("sends the token via the X-Figma-Token header (never a query param)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ json: { document: {} } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchFileDocument("KEY", "secret-tok");
    const [url, opts] = fetchMock.mock.calls[0];
    expect((opts.headers as Record<string, string>)["X-Figma-Token"]).toBe("secret-tok");
    expect(String(url)).not.toContain("secret-tok");
  });
});

describe("fetchNodeImages", () => {
  // The 400 fix: print-canvas nodes were requested 50-at-a-time at scale=1, whose
  // COMBINED render area (≈420–693 MP) Figma's /images rejects. Now we render at a
  // size-derived reduced scale and cap ids per request, then merge.
  it("renders at a reduced, size-derived scale and caps ids per request", async () => {
    // 60 print-canvas nodes (long edge 4096) → scale = 1600/4096 ≈ 0.391, and the
    // 25-id cap splits them into 25 + 25 + 10 = three requests.
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      width: 2048,
      height: 4096,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res({ json: { images: { n0: "https://u/0", n1: null } } }))
      .mockResolvedValueOnce(res({ json: { images: { n25: "https://u/25", n26: "" } } }))
      .mockResolvedValueOnce(res({ json: { images: { n50: "https://u/50" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const merged = await fetchNodeImages("KEY", nodes, "tok");

    expect(fetchMock).toHaveBeenCalledTimes(3); // 25 + 25 + 10 (id cap)
    // Every request renders below full resolution (never scale=1) at the same scale.
    for (const call of fetchMock.mock.calls) {
      const scale = new URL(String(call[0])).searchParams.get("scale");
      expect(Number(scale)).toBeCloseTo(0.391, 3);
    }
    expect(merged).toEqual({
      n0: "https://u/0",
      n25: "https://u/25",
      n50: "https://u/50",
    });
  });

  it("renders packed chunks concurrently (bounded pool), then merges every result", async () => {
    // 60 nodes → 3 packed chunks (25/25/10). Defer each response so we can observe
    // that the chunk requests are issued together (parallel) rather than one-after-
    // another — the fix for the sequential render that timed out the 242 batch.
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      width: 2048,
      height: 4096,
    }));
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchNodeImages("KEY", nodes, "tok");
    await Promise.resolve(); // flush microtasks so every runner issues its fetch

    // All three chunk requests are in flight at once — none has resolved yet.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    resolvers[0](res({ json: { images: { n0: "https://u/0" } } }));
    resolvers[1](res({ json: { images: { n25: "https://u/25" } } }));
    resolvers[2](res({ json: { images: { n50: "https://u/50" } } }));

    await expect(pending).resolves.toEqual({
      n0: "https://u/0",
      n25: "https://u/25",
      n50: "https://u/50",
    });
  });

  it("never upscales when a node is already small", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ json: { images: { a: "https://u/a" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchNodeImages("KEY", [{ id: "a", width: 400, height: 300 }], "tok");
    const scale = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("scale");
    expect(scale).toBe("1");
  });

  it("falls back to a conservative scale when node sizes are unknown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ json: { images: { a: "https://u/a" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchNodeImages("KEY", [{ id: "a" }], "tok");
    const scale = Number(
      new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("scale"),
    );
    expect(scale).toBeLessThan(1); // unknown dims → assume a large canvas, don't upscale
  });

  it("makes no request for an empty node set", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNodeImages("KEY", [], "tok")).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-200 image request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ ok: false, status: 502 })),
    );
    await expect(fetchNodeImages("KEY", [{ id: "a" }], "tok")).rejects.toThrow(
      /image request failed \(502\)/,
    );
  });
});

describe("fetchRenderedImage (SSRF + size guards)", () => {
  it("rejects a non-Figma host WITHOUT fetching (SSRF guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRenderedImage("https://evil.example.com/x.png")).rejects.toThrow(
      /host not allowed/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-https Figma URL (SSRF guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRenderedImage("http://figma.com/x.png")).rejects.toThrow(
      /host not allowed/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to follow redirects (redirect: 'error')", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ bytes: new Uint8Array([1, 2, 3]), headers: { "content-length": "3" } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchRenderedImage(ALLOWED);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.redirect).toBe("error");
  });

  it("throws on a non-200 download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ ok: false, status: 403 })),
    );
    await expect(fetchRenderedImage(ALLOWED)).rejects.toThrow(/download failed \(403\)/);
  });

  it("enforces the size cap from the Content-Length header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ headers: { "content-length": String(11 * 1024 * 1024) } })),
    );
    await expect(fetchRenderedImage(ALLOWED)).rejects.toThrow(/too large/i);
  });

  it("returns the bytes for a valid small image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ bytes: new Uint8Array([1, 2, 3]), headers: { "content-length": "3" } })),
    );
    const bytes = await fetchRenderedImage(ALLOWED);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  // #250: `declared` defaults to 0 when the header is absent/zero (chunked
  // transfer-encoding), so the Content-Length pre-check is skipped entirely and
  // the 10MB cap used to be enforced only AFTER res.arrayBuffer() had already
  // pulled the whole body into memory — under RENDER_CONCURRENCY that's real
  // memory pressure on the import path, not a theoretical one.
  it("caps an oversized body that sends NO Content-Length (chunked)", async () => {
    const chunks = Array.from({ length: 11 }, () => new Uint8Array(1024 * 1024));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ chunks })));
    await expect(fetchRenderedImage(ALLOWED)).rejects.toThrow(/too large/i);
  });

  it("caps a body whose Content-Length understates its real size", async () => {
    const chunks = Array.from({ length: 11 }, () => new Uint8Array(1024 * 1024));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ chunks, headers: { "content-length": "512" } })),
    );
    await expect(fetchRenderedImage(ALLOWED)).rejects.toThrow(/too large/i);
  });

  it("aborts an oversized download early instead of buffering it all", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024)); // endless 1MB chunks
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body,
        arrayBuffer: async () => {
          throw new Error("arrayBuffer() must not be used — it is unbounded");
        },
      } as unknown as Response),
    );
    await expect(fetchRenderedImage(ALLOWED)).rejects.toThrow(/too large/i);
    // 10MB cap / 1MB chunks = 11 pulls to cross it. An unbounded read of this
    // never-closing stream would have run until OOM.
    expect(pulled).toBeLessThanOrEqual(13);
  });

  it("accepts a body that exactly hits the cap", async () => {
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(1024 * 1024));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ chunks })));
    const bytes = await fetchRenderedImage(ALLOWED);
    expect(bytes.byteLength).toBe(10 * 1024 * 1024);
  });

  it("reassembles a multi-chunk body byte-exactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        res({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])] }),
      ),
    );
    await expect(fetchRenderedImage(ALLOWED)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });
});
