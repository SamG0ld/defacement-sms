// Private-image storage on Vercel Blob. Images that may carry PII (deploy photos)
// or that we simply don't want world-readable (sign art previews) are stored with
// `access: "private"` — the blob URL alone won't serve them. We persist the
// returned blob *pathname* (server-side only) and stream the bytes back through an
// auth-gated route, which calls `get(..., { access: "private" })` server-side with
// BLOB_READ_WRITE_TOKEN. Clients only ever see our gated serving URL.
//
// Generalized from the original deploy-photo helper: the only thing that varied
// per use was the path prefix, so it's a parameter now. `lib/deploy/blob.ts` wraps
// these with the "deploy-photos" prefix; sign previews use "sign-previews".

import { put, get, del } from "@vercel/blob";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// Upload validated image bytes under `<prefix>/<id>.<ext>`; returns the stored
// blob pathname. addRandomSuffix avoids collisions/overwrite errors on re-upload —
// we keep whatever pathname the store hands back.
export async function putPrivateImage(
  prefix: string,
  id: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
  const ext = EXT[contentType] ?? "bin";
  const { pathname } = await put(`${prefix}/${safeId}.${ext}`, Buffer.from(bytes), {
    access: "private",
    addRandomSuffix: true,
    contentType,
  });
  return pathname;
}

// Best-effort delete of a stored blob (used to reclaim the previous object when a
// preview is replaced or removed). Failures are swallowed: a leaked blob is a cost
// nuisance, never a reason to fail the user-facing write that already succeeded.
export async function deletePrivateImage(blobPathname: string): Promise<void> {
  try {
    await del(blobPathname);
  } catch (err) {
    console.error("blob del failed", blobPathname, err);
  }
}

// Stream a private blob to the (already-authenticated) caller, honoring a
// conditional request so repeat loads return 304 without re-downloading.
export async function streamPrivateImage(
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
    return new Response("Image unavailable", { status: 502 });
  }
  if (!result) return new Response("Not found", { status: 404 });
  if (result.statusCode === 304) {
    // The SDK may not populate `blob` on a not-modified result; the client's
    // If-None-Match produced the 304, so it's the correct ETag to echo.
    const etag = result.blob?.etag ?? ifNoneMatch;
    return new Response(null, {
      status: 304,
      headers: etag ? { ETag: etag } : undefined,
    });
  }
  return new Response(result.stream, {
    status: 200,
    headers: {
      "Content-Type": result.blob.contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // no-cache (not no-store): the browser keeps the bytes but revalidates
      // every use — the ETag/304 path above makes that one cheap conditional
      // request, and a replaced photo/preview shows up immediately on the floor.
      "Cache-Control": "private, no-cache",
      ETag: result.blob.etag,
    },
  });
}
