import {
  ApiError,
  apiError,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { validateImageUpload, MAX_IMAGE_BYTES } from "@/lib/image-upload";
import { uploadDeployPhoto, streamDeployPhoto } from "@/lib/deploy/blob";
import { attachDeployPhoto } from "@/lib/deploy/service";
import { prisma } from "@/lib/db";

// Blob upload + DB writes — bound the worst case.
export const maxDuration = 30;

const IMAGE_ERROR: Record<string, string> = {
  empty: "Photo is empty.",
  too_large: "Photo is too large (max 10 MB).",
  unsupported_type: "Unsupported image type — PNG, JPEG, or WebP only.",
  bad_dimensions: "Couldn't read the photo's dimensions — the file may be corrupt.",
  too_many_pixels: "Photo resolution is too large (max 40 megapixels).",
};

// POST /api/native/deploys/[clientId]/photo — attach a deploy photo. Body is the
// raw image bytes (Content-Type set by the client; we ignore it and sniff). Runs
// only after the deploy event is accepted, so a slow/absent photo never blocks
// the deploy. Private Blob upload, stored server-side; the response hands back a
// gated serving URL.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  return runApi(req, async () => {
    await requireApiSession();

    // Cheap reject before allocating the body: a hostile multi-GB upload must not
    // be buffered into memory just to fail the cap afterwards. Content-Length is
    // client-supplied, so the post-read check below is still authoritative.
    const declaredLen = Number(req.headers.get("content-length") ?? 0);
    if (declaredLen > MAX_IMAGE_BYTES) {
      throw new ApiError(413, IMAGE_ERROR.too_large);
    }

    // Verify the deploy event exists BEFORE spending Blob storage, so an unknown
    // clientId can't orphan bytes in the store.
    const event = await prisma.deployEvent.findUnique({
      where: { clientId },
      select: { id: true },
    });
    if (!event) throw new ApiError(404, "unknown deploy event");

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ApiError(413, IMAGE_ERROR.too_large);
    }
    const result = validateImageUpload(bytes);
    if (!result.ok) {
      throw new ApiError(400, IMAGE_ERROR[result.error] ?? "Invalid image.");
    }

    const pathname = await uploadDeployPhoto(clientId, bytes, result.image.contentType);
    const signId = await attachDeployPhoto(clientId, pathname);
    if (signId === null) throw new ApiError(404, "unknown deploy event");
    return { clientId, photoUrl: `/api/native/photos/sign/${signId}` };
  });
}

// GET /api/native/deploys/[clientId]/photo — stream this event's photo (used by
// the deploy log, which is keyed by event/clientId).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  try {
    await requireApiSession();
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.status, err.message);
    console.error("/api/native photo session check failed", err);
    return apiError(500, "internal error");
  }
  const { clientId } = await params;
  const event = await prisma.deployEvent.findUnique({
    where: { clientId },
    select: { photoUrl: true },
  });
  if (!event?.photoUrl) return new Response("Not found", { status: 404 });
  return streamDeployPhoto(event.photoUrl, req.headers.get("if-none-match"));
}
