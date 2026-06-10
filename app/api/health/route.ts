import { NextResponse } from "next/server";

// Unauthenticated liveness probe for container/orchestrator healthchecks (Docker
// HEALTHCHECK, uptime-kuma). Deliberately does NOT touch the database: this
// reports "the app process is up and serving," not DB readiness — DB readiness is
// gated separately by the entrypoint's `prisma migrate deploy` and the db
// service's own pg_isready healthcheck, so a slow/migrating DB won't flap the app.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "defcon-sms", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
