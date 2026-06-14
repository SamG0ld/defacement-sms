import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

// Prisma needs the Node runtime (not edge).
export const runtime = "nodejs";

// Login-audit rows older than this are purged. Scoped to auth.* actions only —
// admin audit history is never deleted.
const RETENTION_DAYS = 90;
const LOGIN_ACTIONS = ["auth.login", "auth.denied"];

// Scheduled retention purge, invoked daily by Vercel Cron (see vercel.json).
// Protected by a shared secret: Vercel Cron sends `Authorization: Bearer
// ${CRON_SECRET}` when the env var is set. Fails CLOSED — a missing or
// mismatched secret returns 401 — because this route is on the proxy's public
// allowlist (cron runs with no session) and must not be triggerable by the
// open internet.
// Constant-time bearer check so the secret can't be recovered byte-by-byte via
// response timing. Unequal lengths short-circuit (timingSafeEqual throws on
// length-mismatched buffers).
function bearerMatches(provided: string | null, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !bearerMatches(req.headers.get("authorization"), secret)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.auditLog.deleteMany({
    where: { action: { in: LOGIN_ACTIONS }, createdAt: { lt: cutoff } },
  });

  return NextResponse.json({ purged: count, cutoff: cutoff.toISOString() });
}
