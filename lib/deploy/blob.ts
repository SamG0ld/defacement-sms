// Deployment-photo storage on Vercel Blob, PRIVATE access. Deploy photos can show
// badges/faces/PII, so they must never be world-readable. The storage mechanics
// are shared with sign-art previews and live in `lib/blob-image.ts`; this module
// is a thin, behavior-preserving wrapper that pins the "deploy-photos" prefix.
// (The serving route — app/api/native/photos/* — streams the bytes back gated.)

import { putPrivateImage, streamPrivateImage } from "@/lib/blob-image";

const PREFIX = "deploy-photos";

// Upload validated image bytes; returns the stored blob pathname.
export function uploadDeployPhoto(
  clientId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  return putPrivateImage(PREFIX, clientId, bytes, contentType);
}

// Stream a private blob to the (already-authenticated) caller, honoring a
// conditional request so repeat loads return 304 without re-downloading.
export function streamDeployPhoto(
  blobPathname: string,
  ifNoneMatch: string | null,
): Promise<Response> {
  return streamPrivateImage(blobPathname, ifNoneMatch);
}
