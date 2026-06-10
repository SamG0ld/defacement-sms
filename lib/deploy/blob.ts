// Deployment-photo storage on Vercel Blob, PRIVATE access. Photos can show
// badges/faces/PII, so they must never be world-readable: we store them with
// `access: "private"` (the blob URL alone won't serve them) and stream the bytes
// back only through our own auth-gated route (app/api/native/photos/*), which
// calls `get(..., { access: "private" })` server-side with BLOB_READ_WRITE_TOKEN.
// We persist the returned blob *pathname* (server-side only) in the DB — clients
// only ever see the gated serving URL.

import { put, get } from "@vercel/blob";

const PREFIX = "deploy-photos";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// Upload validated image bytes; returns the stored blob pathname. addRandomSuffix
// avoids collisions/overwrite errors on re-upload — we keep whatever pathname the
// store hands back.
export async function uploadDeployPhoto(
  clientId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const safeId = clientId.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
  const ext = EXT[contentType] ?? "bin";
  const { pathname } = await put(`${PREFIX}/${safeId}.${ext}`, Buffer.from(bytes), {
    access: "private",
    addRandomSuffix: true,
    contentType,
  });
  return pathname;
}

// Stream a private blob to the (already-authenticated) caller, honoring a
// conditional request so repeat loads return 304 without re-downloading.
export async function streamDeployPhoto(
  blobPathname: string,
  ifNoneMatch: string | null,
): Promise<Response> {
  let result;
  try {
    result = await get(blobPathname, {
      access: "private",
      ifNoneMatch: ifNoneMatch ?? undefined,
    });
  } catch (err) {
    // Some SDK versions throw (rather than return null) for a missing blob. Treat
    // a missing object as 404; surface anything else as a 502 (upstream failure).
    console.error("blob get failed", blobPathname, err);
    return new Response("Photo unavailable", { status: 502 });
  }
  if (!result) return new Response("Not found", { status: 404 });
  if (result.statusCode === 304) {
    return new Response(null, {
      status: 304,
      headers: { ETag: result.blob.etag },
    });
  }
  return new Response(result.stream, {
    status: 200,
    headers: {
      "Content-Type": result.blob.contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300, must-revalidate",
      ETag: result.blob.etag,
    },
  });
}
