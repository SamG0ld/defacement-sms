import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import {
  MAX_EXPORT_ROWS,
  signExportSelect,
  signRowsToSectionedCsv,
} from "@/lib/sign-export";

import { buildSignWhere } from "../../_lib";

// Authenticated, per-user, per-filter data — never cache it.
export const dynamic = "force-dynamic";

// Human-audit "by size" export of the current (filtered) board: the SAME columns
// as the flat export, but grouped into `=== FORMAT ===` sections (one per size).
// Honors the same query params as the list page + the flat export so it exports
// exactly what's on screen. It is a read-only report — the section header rows
// make it deliberately non-importable (never fed back through parseSignListCsv).
// Any active user (like the flat export).
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
    category: sp.get("category") ?? undefined,
    q: sp.get("q") ?? undefined,
    due: sp.get("due") ?? undefined,
  });
  // Test data is excluded unconditionally, matching the flat export — this report is what
  // a lead eyeballs to sign off the by-size breakdown before print, so a throwaway test
  // sign in it would be counted as real work. Scoped here, not in buildSignWhere.
  where.isTestData = false;

  // Order is applied by size in signRowsToSectionedCsv (format order, then Item
  // ID within a section); the DB order here is just a stable itemId scan.
  const signs = await prisma.sign.findMany({
    where,
    select: signExportSelect,
    orderBy: [{ itemId: "asc" }],
    take: MAX_EXPORT_ROWS,
  });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(signRowsToSectionedCsv(signs), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="signs-by-size-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
