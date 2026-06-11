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
import { MAX_IMAGE_BYTES } from "@/lib/image-upload";

const FIGMA_API = "https://api.figma.com/v1";
// Figma's /images endpoint takes many ids per call; chunk defensively so a big
// batch can't build an over-long URL.
const IMAGE_ID_CHUNK = 50;

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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /v1/images/:key?ids=…&format=png&scale=1 → { nodeId: temporaryUrl }. Renders
// the requested nodes; scale=1 yields the working-canvas resolution (a web preview,
// not the print export). Chunked + merged. A node Figma can't render comes back with
// a null url, which we simply omit.
export async function fetchNodeImages(
  fileKey: string,
  nodeIds: string[],
  token: string,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const part of chunk(nodeIds, IMAGE_ID_CHUNK)) {
    const params = new URLSearchParams({
      ids: part.join(","),
      format: "png",
      scale: "1",
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
      if (typeof url === "string" && url) merged[id] = url;
    }
  }
  return merged;
}

// Download a rendered image from a Figma temporary URL into bytes, guarded by the
// host allowlist (lib/figma → isAllowedImageHost) + the same size cap as user
// uploads (Content-Length pre-check and an authoritative post-read check). Caller
// magic-byte-validates before storing.
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
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Rendered image is too large (max 10 MB).");
  }
  return bytes;
}
