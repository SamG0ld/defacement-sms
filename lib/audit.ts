import { prisma } from "@/lib/db";

// Append-only audit recorder for destructive / sensitive admin actions. Writes
// one AuditLog row. Best-effort by design: a logging failure is swallowed (and
// surfaced to server logs) so it can never block or roll back the action it is
// meant to record.
export async function recordAudit(entry: {
  action: string;
  actorId?: string | null;
  actorEmail?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        detail: entry.detail ?? null,
      },
    });
  } catch (err) {
    console.error("recordAudit failed", entry.action, err);
  }
}
