import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { checkActionRateLimit } from "@/lib/ratelimit";
import { requireRole } from "@/lib/rbac";

import { computeBucketManifest, isKnownBucketKey } from "../_manifest";

// Downloadable per-size reconcile manifest (JSON) — the artifact the follow-on Figma
// plugin/MCP pass consumes to delete/append nodes by hand. Re-derives server-side from
// the live DB + a fresh Figma fetch (never trusts client input beyond the bucket key).
// Lead-gated: the delete list names real Figma node IDs.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    const session = await requireRole("lead");
    userId = session.user.id;
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { success } = await checkActionRateLimit(`figma-manifest:${userId}`);
  if (!success) {
    return new NextResponse("Too many manifest requests", { status: 429 });
  }

  const bucket = req.nextUrl.searchParams.get("bucket") ?? "";
  if (!isKnownBucketKey(bucket)) {
    return new NextResponse("Unknown size bucket", { status: 400 });
  }

  const result = await computeBucketManifest(bucket, new Date().toISOString());
  if (!result.ok) {
    return new NextResponse(result.error, { status: 400 });
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(result.manifest, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="figma-manifest-${bucket}-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
