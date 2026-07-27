// Server-only Figma REST client for importer A (pull rendered sign previews).
// The Figma REST API is plain HTTPS, so unlike the Figma/cairo *render* step this
// runs fine on Vercel. The token is a Figma personal access token read from the
// environment; it is never sent to the client or logged.
//
// Pure parsing/matching lives in lib/figma.ts (figmaFileKey) and lib/figma-match.ts
// so this module is just the network edge.

// Guard: this module reads a secret (FIGMA_API_TOKEN) and makes authenticated
// outbound calls — importing it into a client bundle must be a build error.
import "server-only";

import { isAllowedImageHost } from "@/lib/figma";
import { BodyTooLargeError, readBoundedBytes } from "@/lib/http-body";
import { MAX_IMAGE_BYTES } from "@/lib/image-upload";

const FIGMA_API = "https://api.figma.com/v1";

// Rendered previews are shown as a thumbnail (max-h-48) or a lightbox — never at print
// resolution. Cap the rendered long edge so (a) every /images request stays well under
// Figma's per-request render budget and (b) previews match the app's own 1600px upload
// downscale (lib/preview-image MAX_EDGE).
const PREVIEW_MAX_EDGE = 1600;
// Figma's /images rejects a request whose COMBINED render area is too large — the root
// cause of the 400 on the 78/242-sign per-format files (50 print-canvas nodes at
// scale=1 ≈ 420–693 MP). Pack each request under a conservative pixel budget, with a
// hard id cap as a second, belt-and-suspenders bound.
const MAX_REQUEST_PIXELS = 80_000_000; // 80 MP — well under the observed failure range
const MAX_IDS_PER_REQUEST = 25;
// When a node's size is absent from the file JSON, assume a large print canvas so the
// computed scale stays conservative and never upscales.
const FALLBACK_NODE_EDGE = 4096;
// How many packed /images requests to render at once. The old serial `for…await` made
// ~10 chunk requests back-to-back the dominant wall-clock cost of a big batch (what
// pushed the 242-sign import past the route's 300s cap). A small pool overlaps them
// while staying gentle on Figma's render/rate limits — deliberately modest to avoid 429s.
const RENDER_CONCURRENCY = 4;

// A node to render: its id plus (when known) its canvas size, so we can pick a scale.
export type FigmaNodeRef = { id: string; width?: number; height?: number };

// Optional — the feature degrades gracefully when unset (the action reports
// "Figma API token not configured" rather than the app failing at startup).
export function figmaToken(): string | null {
  return process.env.FIGMA_API_TOKEN || null;
}

function authHeaders(token: string): HeadersInit {
  return { "X-Figma-Token": token };
}

// GET /v1/files/:key → the document tree (.document). Throws a friendly Error on a
// non-200 so the action can surface a capped message.
export async function fetchFileDocument(
  fileKey: string,
  token: string,
): Promise<unknown> {
  const res = await fetch(`${FIGMA_API}/files/${encodeURIComponent(fileKey)}`, {
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Figma file request failed (${res.status}).`);
  }
  const json = (await res.json()) as { document?: unknown };
  if (!json.document) throw new Error("Figma file response had no document.");
  return json.document;
}

function nodeLongEdge(n: FigmaNodeRef): number {
  return Math.max(n.width ?? FALLBACK_NODE_EDGE, n.height ?? FALLBACK_NODE_EDGE);
}

// One scale for the whole request set (Figma's /images scale is per-request): shrink the
// largest node's long edge to PREVIEW_MAX_EDGE, never upscale, clamped to Figma's accepted
// 0.01–4 range. Nodes in a per-format file are uniform, so this is effectively exact.
function previewScale(nodes: FigmaNodeRef[]): number {
  const maxEdge = nodes.reduce((m, n) => Math.max(m, nodeLongEdge(n)), 0);
  if (maxEdge <= 0) return 1;
  const s = Math.min(1, PREVIEW_MAX_EDGE / maxEdge);
  // Round to 3 dp (tidy URL/test values; Figma doesn't need finer precision) and clamp to
  // Figma's 0.01 minimum. For the real ~4096px sign canvases s≈0.39 — far from the floor.
  return Math.max(0.01, Math.round(s * 1000) / 1000);
}

// Greedily pack nodes into requests whose COMBINED rendered area (w*h*scale²) stays under
// MAX_REQUEST_PIXELS and whose id count stays under MAX_IDS_PER_REQUEST. Every request
// carries ≥1 id. A scale-capped node never exceeds the budget alone for the real ~4096px
// sign canvases (area ≈ 2.5 MP ≪ 80 MP); and even a pathological over-budget node — only
// possible if `scale` hit its 0.01 floor on a corrupt bbox — still ships ALONE, because
// once `area` is over budget the next node flushes it (it's never packed with siblings).
function packByArea(nodes: FigmaNodeRef[], scale: number): FigmaNodeRef[][] {
  const out: FigmaNodeRef[][] = [];
  let cur: FigmaNodeRef[] = [];
  let area = 0;
  for (const n of nodes) {
    // w*h*scale². A missing axis falls back to a large canvas independently, so the
    // estimate stays conservative (never assumes a node is smaller than it might be).
    const a =
      (n.width ?? FALLBACK_NODE_EDGE) *
      (n.height ?? FALLBACK_NODE_EDGE) *
      scale *
      scale;
    if (
      cur.length > 0 &&
      (cur.length >= MAX_IDS_PER_REQUEST || area + a > MAX_REQUEST_PIXELS)
    ) {
      out.push(cur);
      cur = [];
      area = 0;
    }
    cur.push(n);
    area += a;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// Render one packed chunk: GET /v1/images/:key?ids=…&format=png&scale=S →
// { nodeId: temporaryUrl }. Merges the non-null urls into `out` (safe from several
// concurrent callers: JS is single-threaded between awaits and each assignment is atomic).
async function renderChunk(
  fileKey: string,
  part: FigmaNodeRef[],
  scale: number,
  token: string,
  out: Record<string, string>,
): Promise<void> {
  const params = new URLSearchParams({
    ids: part.map((n) => n.id).join(","),
    format: "png",
    scale: String(scale),
  });
  const res = await fetch(
    `${FIGMA_API}/images/${encodeURIComponent(fileKey)}?${params}`,
    { headers: authHeaders(token), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`Figma image request failed (${res.status}).`);
  }
  const json = (await res.json()) as { images?: Record<string, string | null> };
  for (const [id, url] of Object.entries(json.images ?? {})) {
    if (typeof url === "string" && url) out[id] = url;
  }
}

// GET /v1/images renders the requested nodes at a reduced, area-bounded scale
// (previewScale / packByArea) so a big print-canvas batch can't blow Figma's per-request
// render budget (the 400 on the 78/242 files). A node Figma can't render comes back with a
// null url, which we simply omit. The packed chunks run through a small bounded pool
// (RENDER_CONCURRENCY) rather than strictly serially — overlapping the ~N chunk renders is
// what keeps a large batch well under the caller's time budget (the 242 timeout).
export async function fetchNodeImages(
  fileKey: string,
  nodes: FigmaNodeRef[],
  token: string,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  if (nodes.length === 0) return merged;
  const scale = previewScale(nodes);
  const parts = packByArea(nodes, scale);

  // Bounded pool: at most RENDER_CONCURRENCY chunk renders in flight. Each runner pulls
  // the next chunk index until they're exhausted; a chunk failure rejects the batch (same
  // fail-fast contract as the old serial loop).
  let next = 0;
  const runners = Array.from(
    { length: Math.min(RENDER_CONCURRENCY, parts.length) },
    async () => {
      while (next < parts.length) {
        const idx = next;
        next += 1;
        await renderChunk(fileKey, parts[idx], scale, token, merged);
      }
    },
  );
  await Promise.all(runners);
  return merged;
}

// Download a rendered image from a Figma temporary URL into bytes, guarded by the
// host allowlist (lib/figma → isAllowedImageHost) + the same size cap as user
// uploads. The Content-Length check is an advisory fast path only — it is absent
// under chunked transfer-encoding, so the authoritative cap is the bounded
// STREAM read below, which aborts mid-download once the running total crosses
// MAX_IMAGE_BYTES. Reading the body with res.arrayBuffer() would have buffered
// the whole thing first (#250), which under RENDER_CONCURRENCY parallel imports
// is real memory pressure on a 300s-budget path. Caller magic-byte-validates
// before storing.
//
// redirect: "error" — the host check only validates the FIRST hop, so we refuse to
// follow redirects at all rather than let an allowed host 3xx the fetch onto an
// internal address (SSRF). Figma's CDN/S3 URLs are direct 200s; a (rare) redirect
// just reports that sign as failed, which is safe degradation.
export async function fetchRenderedImage(rawUrl: string): Promise<Uint8Array> {
  if (!isAllowedImageHost(rawUrl)) {
    throw new Error("Rendered image URL host not allowed.");
  }
  const res = await fetch(rawUrl, { cache: "no-store", redirect: "error" });
  if (!res.ok) {
    throw new Error(`Rendered image download failed (${res.status}).`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    throw new Error("Rendered image is too large (max 10 MB).");
  }
  try {
    return await readBoundedBytes(res.body, MAX_IMAGE_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new Error("Rendered image is too large (max 10 MB).");
    }
    throw err;
  }
}
