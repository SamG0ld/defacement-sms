import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import {
  MAX_EXPORT_ROWS,
  signExportSelect,
  signRowsToCsv,
} from "@/lib/sign-export";

// Authenticated, per-batch data — never cache it.
export const dynamic = "force-dynamic";

// The generation handoff: the render-ready CSV for exactly one batch's signs
// (the input the Figma render step consumes). Identical column shape
// to the main /signs export (shared via lib/sign-export), but scoped to the
// batch rather than the current filter — so you can re-download the exact list
// you generated at any time. Any active user (like the main export).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { success } = await checkActionRateLimit(`export:${userId}`);
  if (!success) {
    return new NextResponse("Too many export requests", { status: 429 });
  }

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  const batch = await prisma.generationBatch.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!batch) return new NextResponse("Not found", { status: 404 });

  const signs = await prisma.sign.findMany({
    where: { generationBatchId: id },
    select: signExportSelect,
    // By size, then Item ID — the deploymentPriority sort was a no-op (uniform
    // default). New batches are single-format; size ordering also keeps a legacy
    // mixed-size batch grouped by size.
    orderBy: [{ size: "asc" }, { itemId: "asc" }],
    take: MAX_EXPORT_ROWS,
  });

  return new NextResponse(signRowsToCsv(signs), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="generation-batch-${id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
