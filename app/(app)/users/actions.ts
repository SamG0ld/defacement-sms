"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/email";
import { logError } from "@/lib/log";
import { requireRole } from "@/lib/rbac";
import { checkMutationRateLimit } from "@/lib/ratelimit";

const ROLES = ["admin", "lead", "volunteer"] as const;

// Public origin for links we email out. NextAuth already relies on these vars;
// fall back to localhost so dev still produces a usable (if local) link.
function loginUrl(): string {
  const base =
    process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/login`;
}

// Surface a failure to the page via ?error= (same pattern the login page uses),
// keeping everything server-only with no client components. redirect() throws,
// so this never returns.
function fail(message: string): never {
  redirect(`/users?error=${encodeURIComponent(message)}`);
}

export async function addUser(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");

  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().email(),
      role: z.enum(ROLES),
    })
    .safeParse({ email: formData.get("email"), role: formData.get("role") });
  if (!parsed.success) fail("Enter a valid email and role.");

  // Checkbox: present (value "on") unless the admin unticks it. Default to
  // sending so the common path needs no thought.
  const welcome = formData.get("welcome") !== null;

  try {
    await prisma.user.create({
      data: {
        email: parsed.data.email,
        role: parsed.data.role,
        isActive: true,
        invitedAt: new Date(),
        invitedById: session.user.id,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      fail(`${parsed.data.email} is already a user.`);
    }
    throw err;
  }

  await recordAudit({
    action: "user.add",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Added ${parsed.data.email} as ${parsed.data.role}${welcome ? " (welcome email requested)" : ""}`,
  });

  // Best-effort welcome email — the account already exists, so a send failure
  // must not undo the add. Log and move on; the admin can resend or tell them.
  if (welcome) {
    try {
      await sendWelcomeEmail(parsed.data.email, loginUrl());
    } catch (err) {
      logError("email.welcome-failed", err);
    }
  }

  revalidatePath("/users");
}

export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");
  if (userId === session.user.id) {
    fail("You can't change your own account status.");
  }

  let target: { email: string } | undefined;
  try {
    target = await prisma.user.update({
      where: { id: userId },
      // Deactivating bumps tokenVersion so the existing jwt kill-switch revokes
      // any live session within REFRESH_INTERVAL_MS — 15 minutes (lib/auth.ts).
      // NOT 24h: that's `updateAge`, the unrelated cookie-rotation cadence.
      data: active
        ? { isActive: true }
        : { isActive: false, tokenVersion: { increment: 1 } },
      select: { email: true },
    });
  } catch (err) {
    logError("users.set-active", err);
    fail("Could not update the account. Try again.");
  }

  await recordAudit({
    action: active ? "user.activate" : "user.deactivate",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `${active ? "Reactivated" : "Deactivated"} ${target?.email ?? `user #${userId}`}`,
  });

  revalidatePath("/users");
}

export async function setUserRole(
  userId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");
  if (userId === session.user.id) {
    fail("You can't change your own role.");
  }

  const parsed = z.enum(ROLES).safeParse(formData.get("role"));
  if (!parsed.success) fail("Invalid role.");

  // Capture the prior role BEFORE overwriting — a post-update select would
  // return the new role, leaving a privilege-escalation timeline impossible to
  // reconstruct from the audit log alone. (#82)
  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!before) fail("User not found.");

  try {
    await prisma.user.update({
      where: { id: userId },
      // Any role change bumps tokenVersion so a live session can't ride a
      // now-revoked tier — same kill-switch the deactivation path uses. Takes
      // effect at the session's next JWT refresh.
      data: { role: parsed.data, tokenVersion: { increment: 1 } },
    });
  } catch (err) {
    logError("users.set-role", err);
    fail("Could not update the role. Try again.");
  }

  await recordAudit({
    action: "user.role",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Changed ${before.email} from ${before.role} to ${parsed.data}`,
  });

  revalidatePath("/users");
}

export async function removeUser(userId: string): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");
  if (userId === session.user.id) {
    fail("You can't remove your own account.");
  }

  // Hard delete. Accounts/sessions cascade (schema onDelete: Cascade); invitees'
  // invitedById nulls out (optional FK → SetNull). AuditLog.actorId and
  // StatusHistory.changedBy are free-text, not FKs, so this user's audit/history
  // trail survives the delete. Look up the email first for the audit detail.
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!target) fail("User not found.");

  try {
    await prisma.user.delete({ where: { id: userId } });
  } catch (err) {
    logError("users.remove", err);
    fail("Could not remove the account. Try again.");
  }

  await recordAudit({
    action: "user.remove",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Removed ${target.email} (#${userId})`,
  });

  revalidatePath("/users");
}
