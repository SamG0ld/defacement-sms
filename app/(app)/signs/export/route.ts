import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import {
  MAX_EXPORT_ROWS,
  signExportSelect,
  signRowsToCsv,
} from "@/lib/sign-export";

import { buildSignWhere } from "../_lib";

// Authenticated, per-user, per-filter data — never cache it.
export const dynamic = "force-dynamic";

// CSV of the current (filtered) board. Honors the same query params as the list
// page so "Export CSV" exports exactly what's on screen. Any active user.
export async function GET(req: NextRequest) {
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

  const sp = req.nextUrl.searchParams;
  const where = buildSignWhere({
    status: sp.get("status") ?? undefined,
    zone: sp.get("zone") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    slot: sp.get("slot") ?? undefined,
    type: sp.get("type") ?? undefined,
    q: sp.get("q") ?? undefined,
  });

  const signs = await prisma.sign.findMany({
    where,
    // Shared select/serializer with the per-batch generation handoff so the two
    // export shapes can't drift (lib/sign-export.ts).
    select: signExportSelect,
    orderBy: [{ deploymentPriority: "asc" }, { itemId: "asc" }],
    take: MAX_EXPORT_ROWS,
  });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(signRowsToCsv(signs), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="signs-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
