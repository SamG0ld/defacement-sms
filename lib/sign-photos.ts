// Sign lifecycle-photo storage on Vercel Blob, PRIVATE access (Phase 2). Proof
// photos for receiving an externally-produced item and handing it off can show
// faces/badges/PII, so — exactly like deploy photos — they are stored with
// `access: "private"` and streamed back only through our own auth-gated route
// (app/api/photos/sign/[signId]/[kind]). We persist the returned blob *pathname*
// (server-side only) on the Sign; clients only ever see the gated serving URL.
//
// The streaming primitive is shared with deploy photos (a private blob is a
// private blob); only the upload key/prefix differ, so this module owns just the
// upload + re-exports the generic streamer under a sign-scoped name.

import { put } from "@vercel/blob";
import { streamDeployPhoto } from "@/lib/deploy/blob";

const PREFIX = "sign-photos";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// The lifecycle moments that capture a photo. Constrained so a serving-route
// `kind` param can never address an arbitrary column.
export type SignPhotoKind = "delivery" | "handoff" | "install";

export const SIGN_PHOTO_KINDS: readonly SignPhotoKind[] = [
  "delivery",
  "handoff",
  "install",
];

// Upload validated image bytes for a sign's lifecycle moment; returns the stored
// blob pathname. addRandomSuffix avoids collisions on re-upload (e.g. a corrected
// delivery photo) — we keep whatever pathname the store hands back.
export async function uploadSignPhoto(
  signId: number,
  kind: SignPhotoKind,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const ext = EXT[contentType] ?? "bin";
  const { pathname } = await put(
    `${PREFIX}/${signId}-${kind}.${ext}`,
    Buffer.from(bytes),
    { access: "private", addRandomSuffix: true, contentType },
  );
  return pathname;
}

// Stream a private sign photo to an already-authenticated caller (304-aware).
// Generic over any private blob pathname — reuses the deploy-photo streamer.
export const streamSignPhoto = streamDeployPhoto;
