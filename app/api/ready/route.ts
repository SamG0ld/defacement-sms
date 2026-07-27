import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { logWarn } from "@/lib/log";

// Unauthenticated READINESS probe (m17 #86). Where /api/health is liveness ("the
// process is up"), this confirms the app can actually serve by checking database
// connectivity with a trivial `SELECT 1`. A Postgres outage *after* startup makes
// every DB-backed request 500 while /api/health still returns ok — so containers,
// uptime monitors, and orchestrators should gate on /api/ready to report a
// degraded pod unhealthy instead of letting it silently serve 500s.
//
// The body is intentionally generic on failure (no raw error string): this is a
// public, unauthenticated endpoint and must not leak DB host/driver internals.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ready", service: "defcon-sms", time: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // WARN, not error→Sentry: this probe is public and polled on a short interval,
    // so funneling every failure to Sentry would be a public-endpoint amplification
    // path. The structured stderr line stays searchable (scope "ready.db-check-failed")
    // in the Vercel log viewer; real request-path DB failures still reach Sentry via
    // their own logError sites.
    const e = err as { name?: string; code?: string | number };
    logWarn("ready.db-check-failed", "readiness probe SELECT 1 failed", {
      name: e.name,
      code: e.code,
    });
    return NextResponse.json(
      { status: "not_ready", service: "defcon-sms", time: new Date().toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
