"use server";

import { checkActionRateLimit } from "@/lib/ratelimit";
import { requireRole } from "@/lib/rbac";

import {
  computeBucketManifest,
  isKnownBucketKey,
  type BucketManifestResult,
} from "./_manifest";

// Generate the reconcile manifest for one size bucket, for the on-page preview. Lead-
// gated + rate-limited (each call is a live Figma fetch). The server re-derives the whole
// manifest from the live DB + a fresh fetch on every call — the client passes only a
// bucket key, never node data or a changeset.
export async function generateBucketManifest(
  bucketKey: string,
): Promise<BucketManifestResult> {
  const session = await requireRole("lead");

  if (typeof bucketKey !== "string" || !isKnownBucketKey(bucketKey)) {
    return { ok: false, error: "Unknown size bucket." };
  }

  const { success } = await checkActionRateLimit(
    `figma-manifest:${session.user.id}`,
  );
  if (!success) {
    return {
      ok: false,
      error: "Too many manifest requests — wait a minute and try again.",
    };
  }

  return computeBucketManifest(bucketKey, new Date().toISOString());
}
