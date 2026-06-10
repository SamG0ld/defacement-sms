import { ApiError, apiError, requireApiSession } from "@/lib/deploy/api-session";
import { streamDeployPhoto } from "@/lib/deploy/blob";
import { prisma } from "@/lib/db";

// GET /api/native/photos/sign/[signId] — stream a sign's latest deploy photo,
// auth-gated. The DB stores a private Blob pathname; this route streams it
// through us so the blob is never world-readable.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ signId: string }> },
): Promise<Response> {
  try {
    await requireApiSession();
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.status, err.message);
    console.error("/api/native photo session check failed", err);
    return apiError(500, "internal error");
  }
  const { signId } = await params;
  const id = Number.parseInt(signId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Not found", { status: 404 });
  }
  const sign = await prisma.sign.findUnique({
    where: { id },
    select: { deployPhotoUrl: true },
  });
  if (!sign?.deployPhotoUrl) return new Response("Not found", { status: 404 });
  return streamDeployPhoto(sign.deployPhotoUrl, req.headers.get("if-none-match"));
}
