import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

// Serves a floor map's image bytes from the DB (floor_maps.image_data). This is
// how the static public/maps/*.png were replaced — maps are now managed in-app.
//
// Auth: proxy.ts already gates this path (no file extension → not excluded from
// the matcher, not in PUBLIC_PREFIXES), so an unauthenticated request never
// reaches here. The explicit session check below is defense-in-depth.
//
// Served regardless of `enabled`: a disabled map is hidden from pickers, but an
// existing sign/room may still reference it — serving the bytes avoids a broken
// image. The ETag (the row's updatedAt) lets the browser revalidate cheaply when
// an admin replaces an image.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session?.user?.id || session.user.isActive === false) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { key } = await params;

  // Read metadata only first. A conditional request (If-None-Match) then returns
  // 304 WITHOUT pulling the (up to 10 MB) bytea out of Postgres — so repeated
  // cache-validating loads never touch the blob.
  const meta = await prisma.floorMap.findUnique({
    where: { key },
    select: { contentType: true, updatedAt: true },
  });
  if (!meta) return new Response("Not found", { status: 404 });

  const etag = `"${meta.updatedAt.getTime()}"`;
  if (_req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // Cache miss → fetch the bytes. Re-check in case the row was deleted between
  // the two queries.
  const full = await prisma.floorMap.findUnique({
    where: { key },
    select: { imageData: true },
  });
  if (!full) return new Response("Not found", { status: 404 });

  // Prisma Bytes → Uint8Array; a fresh copy so the response body owns a clean
  // ArrayBuffer (not the larger pooled buffer the driver may hand back).
  const bytes = Uint8Array.from(full.imageData);
  return new Response(bytes, {
    status: 200,
    headers: {
      // contentType is a sniffed literal (image/png|jpeg|webp), never client-set.
      "Content-Type": meta.contentType,
      // Defense-in-depth: never let the browser sniff this as anything else, and
      // render it inline as an image rather than treating it as a document.
      // (X-Content-Type-Options is also set globally in next.config.ts.)
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Private (auth-gated) + revalidate via ETag so a replaced image is picked
      // up promptly without re-downloading on every navigation.
      "Cache-Control": "private, max-age=300, must-revalidate",
      ETag: etag,
    },
  });
}
