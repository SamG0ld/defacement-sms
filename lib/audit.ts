import { prisma } from "@/lib/db";
import { logError } from "@/lib/log";

// Append-only audit recorder for destructive / sensitive admin actions. Writes
// one AuditLog row. Best-effort by design: a logging failure is swallowed (and
// surfaced to server logs) so it can never block or roll back the action it is
// meant to record.
export async function recordAudit(entry: {
  action: string;
  actorId?: string | null;
  actorEmail?: string | null;
  detail?: string | null;
  // Login-event context (auth.login / auth.denied); omitted for admin events.
  userAgent?: string | null;
  location?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        detail: entry.detail ?? null,
        userAgent: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
        location: entry.location ?? null,
      },
    });
  } catch (err) {
    logError("audit.record-failed", err, { action: entry.action });
  }
}
