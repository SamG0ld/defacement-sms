// Auth-gated serving URL for a sign's latest deploy photo. The DB stores a
// private Blob pathname; this route streams it through us so the blob is never
// world-readable (see app/api/native/photos/sign/[signId]/route.ts). Pure +
// client-safe — the single source of truth shared by the deploy bootstrap
// mapping (lib/deploy/service.ts) and the sign-detail / map-pin UI.
export function signDeployPhotoSrc(signId: number): string {
  return `/api/native/photos/sign/${signId}`;
}
