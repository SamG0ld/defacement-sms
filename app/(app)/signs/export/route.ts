import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { toCsv } from "@/lib/csv";

import { buildSignWhere } from "../_lib";

// Authenticated, per-user, per-filter data — never cache it.
export const dynamic = "force-dynamic";

// Safety cap: bound the result set so an unfiltered export can't pull the whole
// table into memory. Comfortably above the real board (~hundreds of signs).
const MAX_EXPORT_ROWS = 10_000;

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
    // Select only the exported columns — the Sign row has ~60 columns; at up to
    // MAX_EXPORT_ROWS that wasted width adds up.
    select: {
      itemId: true,
      signText: true,
      signType: true,
      size: true,
      quantity: true,
      doubleSided: true,
      needsEasel: true,
      status: true,
      placementArea: true,
      deploymentSlot: true,
      deploymentPriority: true,
      costPerUnit: true,
      totalCost: true,
      requestor: true,
      notes: true,
      zone: { select: { zoneCode: true } },
      tagAssignments: { select: { tag: { select: { name: true } } } },
    },
    orderBy: [{ deploymentPriority: "asc" }, { itemId: "asc" }],
    take: MAX_EXPORT_ROWS,
  });

  // Prisma Decimal has toFixed directly — no float round-trip.
  const money = (v: { toFixed(n: number): string } | null) =>
    v == null ? "" : v.toFixed(2);

  const header = [
    "Item ID",
    "Sign Text",
    "Type",
    "Size",
    "Qty",
    "Double-Sided",
    "Needs Easel",
    "Status",
    "Zone",
    "Placement",
    "Deploy Slot",
    "Priority",
    "Cost/Unit",
    "Total Cost",
    "Requestor",
    "Tags",
    "Notes",
  ];

  const rows = signs.map((s) => [
    s.itemId,
    s.signText,
    s.signType,
    s.size,
    s.quantity,
    s.doubleSided ? "Yes" : "No",
    s.needsEasel ? "Yes" : "No",
    s.status,
    s.zone?.zoneCode ?? "",
    s.placementArea ?? "",
    s.deploymentSlot ?? "",
    s.deploymentPriority,
    money(s.costPerUnit),
    money(s.totalCost),
    s.requestor ?? "",
    s.tagAssignments.map((a) => a.tag.name).join("; "),
    s.notes ?? "",
  ]);

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(toCsv([header, ...rows]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="signs-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
