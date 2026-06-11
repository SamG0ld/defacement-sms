import { ApiError, apiError, requireApiSession } from "@/lib/deploy/api-session";
import { prisma } from "@/lib/db";
import {
  SIGN_PHOTO_KINDS,
  streamSignPhoto,
  type SignPhotoKind,
} from "@/lib/sign-photos";

// GET /api/photos/sign/[signId]/[kind] — stream a sign's lifecycle photo
// (kind = delivery | handoff | install), auth-gated. The DB stores a private Blob pathname;
// this route streams it through us so the blob is never world-readable. Mirrors
// app/api/native/photos/sign/[signId] (the deploy-photo equivalent).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ signId: string; kind: string }> },
): Promise<Response> {
  try {
    await requireApiSession();
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.status, err.message);
    console.error("/api/photos session check failed", err);
    return apiError(500, "internal error");
  }
  const { signId, kind } = await params;
  const id = Number.parseInt(signId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Not found", { status: 404 });
  }
  if (!SIGN_PHOTO_KINDS.includes(kind as SignPhotoKind)) {
    return new Response("Not found", { status: 404 });
  }
  const sign = await prisma.sign.findUnique({
    where: { id },
    select: {
      deliveryPhotoUrl: true,
      handoffPhotoUrl: true,
      installPhotoUrl: true,
    },
  });
  const pathname =
    kind === "delivery"
      ? sign?.deliveryPhotoUrl
      : kind === "handoff"
        ? sign?.handoffPhotoUrl
        : sign?.installPhotoUrl;
  if (!pathname) return new Response("Not found", { status: 404 });
  return streamSignPhoto(pathname, req.headers.get("if-none-match"));
}
