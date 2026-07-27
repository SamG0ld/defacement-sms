import {
  deletePrivateImage,
  putPrivateImage,
  streamPrivateImage,
} from "@/lib/blob-image";
import { validateImageUpload, MAX_IMAGE_BYTES } from "@/lib/image-upload";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { AuthorizationError, requireRole, requireSession } from "@/lib/rbac";
import { prisma } from "@/lib/db";

// Sign-art preview image: the web-resolution render uploaded from Figma (importer
// B). Storage is private Vercel Blob, served back only through the auth-gated GET
// below. POST/DELETE are lead+; GET is any active session.
//
// Auth: proxy.ts already gates /api/* behind a session; the rbac checks here are
// the authoritative authorization (and defense-in-depth for the gate).
//
// The two mutating verbs also take the per-actor mutation budget every other
// mutating surface takes — a role gate is not a throttle, and each call costs a
// Blob PUT/DELETE plus a connection from the max:3 pg pool (#182).

const IMAGE_ERROR: Record<string, string> = {
  empty: "Image is empty.",
  too_large: "Image is too large (max 10 MB).",
  unsupported_type: "Unsupported image type — PNG, JPEG, or WebP only.",
  bad_dimensions: "Couldn't read the image's dimensions — the file may be corrupt.",
  too_many_pixels: "Image resolution is too large (max 40 megapixels).",
};

// Map an rbac AuthorizationError to an HTTP status: 401 when unauthenticated,
// 403 when authenticated but under-privileged.
function authResponse(err: AuthorizationError): Response {
  const status = err.actual ? 403 : 401;
  return new Response(err.actual ? "Forbidden" : "Unauthorized", { status });
}

function parseSignId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// lead+ AND within the caller's mutation budget. Returns the response to send on
// refusal, or null to proceed. The body stays plain text like this route's other
// refusals (PreviewUpload surfaces res.text() verbatim); Retry-After carries the
// window like the edge limiter's 429 in proxy.ts, so a client can back off
// instead of hammering.
async function refuseMutation(): Promise<Response | null> {
  let session;
  try {
    session = await requireRole("lead");
  } catch (err) {
    if (err instanceof AuthorizationError) return authResponse(err);
    throw err;
  }
  const budget = await checkMutationRateLimit(session.user.id);
  if (budget.success) return null;
  const retryAfter = Math.max(1, Math.ceil((budget.reset - Date.now()) / 1000));
  return new Response("Too many requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

// POST /api/signs/[id]/preview — set/replace a sign's art preview. Body is the
// raw (already client-downscaled) image bytes; we ignore the client Content-Type
// and sniff the real one from magic bytes.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const refused = await refuseMutation();
  if (refused) return refused;

  const { id } = await params;
  const signId = parseSignId(id);
  if (signId === null) return new Response("Not found", { status: 404 });

  // Cheap reject before buffering the body: a hostile multi-GB upload must not be
  // read into memory just to fail the cap. Content-Length is client-supplied, so
  // the post-read check below is authoritative.
  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_IMAGE_BYTES) {
    return new Response(IMAGE_ERROR.too_large, { status: 413 });
  }

  // Verify the sign exists BEFORE spending Blob storage, so an unknown id can't
  // orphan bytes in the store. Grab the existing path so we can reclaim it after a
  // successful replace.
  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { previewImagePath: true },
  });
  if (!sign) return new Response("Not found", { status: 404 });

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return new Response(IMAGE_ERROR.too_large, { status: 413 });
  }
  const result = validateImageUpload(bytes);
  if (!result.ok) {
    return new Response(IMAGE_ERROR[result.error] ?? "Invalid image.", {
      status: 400,
    });
  }

  const pathname = await putPrivateImage(
    "sign-previews",
    String(signId),
    bytes,
    result.image.contentType,
  );
  try {
    await prisma.sign.update({
      where: { id: signId },
      data: { previewImagePath: pathname },
    });
  } catch (dbErr) {
    // DB write failed after the upload — delete the just-stored blob so a failed
    // replace can't orphan paid storage (m17 #106).
    await deletePrivateImage(pathname);
    throw dbErr;
  }
  // Reclaim the replaced blob (addRandomSuffix means the new upload has a distinct
  // pathname, so the old object is now orphaned). Best-effort — never fails the write.
  if (sign.previewImagePath && sign.previewImagePath !== pathname) {
    await deletePrivateImage(sign.previewImagePath);
  }
  return Response.json({ ok: true });
}

// DELETE /api/signs/[id]/preview — null out the path, then reclaim the blob
// (best-effort, same as the POST replace path). Returns ok even when there was
// no preview to remove.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const refused = await refuseMutation();
  if (refused) return refused;

  const { id } = await params;
  const signId = parseSignId(id);
  if (signId === null) return new Response("Not found", { status: 404 });

  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { previewImagePath: true },
  });
  if (!sign) return new Response("Not found", { status: 404 });

  if (sign.previewImagePath) {
    await prisma.sign.update({
      where: { id: signId },
      data: { previewImagePath: null },
    });
    // Reclaim the now-unreferenced blob. Best-effort — the DB is already updated.
    await deletePrivateImage(sign.previewImagePath);
  }
  return Response.json({ ok: true });
}

// GET /api/signs/[id]/preview — stream the preview to any active session. The DB
// stores a private Blob pathname; this route streams it through us so the blob is
// never world-readable.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthorizationError) return authResponse(err);
    throw err;
  }

  const { id } = await params;
  const signId = parseSignId(id);
  if (signId === null) return new Response("Not found", { status: 404 });

  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    select: { previewImagePath: true },
  });
  if (!sign?.previewImagePath) return new Response("Not found", { status: 404 });
  return streamPrivateImage(sign.previewImagePath, req.headers.get("if-none-match"));
}
