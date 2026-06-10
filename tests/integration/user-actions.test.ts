import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as the other integration suites: mock request-context APIs +
// auth + the email send (no network), keep Prisma real. Actions signal failure
// by throwing through redirect().
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT");
    (e as unknown as { redirectUrl: string }).redirectUrl = url;
    throw e;
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOTFOUND");
  }),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/email";
import {
  addUser,
  removeUser,
  setUserActive,
  setUserRole,
} from "@/app/(app)/users/actions";

let adminId: string;

beforeEach(async () => {
  // invitedById is a real FK, so the acting admin must be a real row.
  const admin = await prisma.user.upsert({
    where: { email: "test-admin@example.com" },
    update: { role: "admin", isActive: true },
    create: { email: "test-admin@example.com", role: "admin", isActive: true },
  });
  adminId = admin.id;
  vi.mocked(auth).mockResolvedValue({
    user: {
      id: adminId,
      email: "test-admin@example.com",
      isActive: true,
      role: "admin",
    },
  } as never);
});

afterEach(async () => {
  vi.clearAllMocks();
  // users isn't truncated by the global setup (audit_log / status_history are).
  await prisma.user.deleteMany({ where: { email: { startsWith: "test-" } } });
});

async function captureRedirect(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { redirectUrl?: string }).redirectUrl;
    // Decode so assertions match the human message, not its URL-encoding
    // (encodeURIComponent → %20, URLSearchParams → +).
    if (url !== undefined) return decodeURIComponent(url.replace(/\+/g, " "));
    throw e;
  }
  throw new Error("expected a redirect, but none was thrown");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("addUser", () => {
  it("creates a user, audits it, and sends the welcome email by default", async () => {
    await addUser(form({ email: "test-new@example.com", role: "volunteer", welcome: "on" }));

    const u = await prisma.user.findUnique({ where: { email: "test-new@example.com" } });
    expect(u?.role).toBe("volunteer");
    expect(u?.invitedById).toBe(adminId);

    const audit = await prisma.auditLog.findFirst({ where: { action: "user.add" } });
    expect(audit?.detail).toContain("test-new@example.com");

    expect(sendWelcomeEmail).toHaveBeenCalledOnce();
    expect(vi.mocked(sendWelcomeEmail).mock.calls[0][0]).toBe("test-new@example.com");
  });

  it("skips the welcome email when the checkbox is unticked", async () => {
    // No `welcome` field => unchecked.
    await addUser(form({ email: "test-silent@example.com", role: "lead" }));
    expect(await prisma.user.findUnique({ where: { email: "test-silent@example.com" } })).not.toBeNull();
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("rejects a duplicate email", async () => {
    await prisma.user.create({ data: { email: "test-dup@example.com", role: "volunteer" } });
    const url = await captureRedirect(addUser(form({ email: "test-dup@example.com", role: "volunteer" })));
    expect(url).toMatch(/already a user/i);
  });
});

describe("setUserRole", () => {
  it("changes the role and audits it", async () => {
    const u = await prisma.user.create({ data: { email: "test-role@example.com", role: "volunteer" } });
    await setUserRole(u.id, form({ role: "lead" }));
    expect((await prisma.user.findUnique({ where: { id: u.id } }))?.role).toBe("lead");
    const audit = await prisma.auditLog.findFirst({ where: { action: "user.role" } });
    expect(audit?.detail).toContain("lead");
  });
});

describe("setUserActive", () => {
  it("deactivates: clears isActive, bumps tokenVersion, audits", async () => {
    const u = await prisma.user.create({
      data: { email: "test-active@example.com", role: "volunteer", isActive: true, tokenVersion: 0 },
    });
    await setUserActive(u.id, false);
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after?.isActive).toBe(false);
    expect(after?.tokenVersion).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { action: "user.deactivate" } })).not.toBeNull();
  });
});

describe("removeUser", () => {
  it("hard-deletes and audits", async () => {
    const u = await prisma.user.create({ data: { email: "test-gone@example.com", role: "volunteer" } });
    await removeUser(u.id);
    expect(await prisma.user.findUnique({ where: { id: u.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "user.remove" } });
    expect(audit?.detail).toContain("test-gone@example.com");
  });

  it("refuses to remove your own account", async () => {
    const url = await captureRedirect(removeUser(adminId));
    expect(url).toMatch(/your own account/i);
    expect(await prisma.user.findUnique({ where: { id: adminId } })).not.toBeNull();
  });

  it("nulls invitees' invitedById and leaves the audit trail intact", async () => {
    const inviter = await prisma.user.create({ data: { email: "test-inviter@example.com", role: "lead" } });
    const invitee = await prisma.user.create({
      data: { email: "test-invitee@example.com", role: "volunteer", invitedById: inviter.id },
    });
    // An audit row whose actor is the user we're about to delete.
    await prisma.auditLog.create({
      data: { action: "test.prior", actorId: inviter.id, actorEmail: inviter.email },
    });

    await removeUser(inviter.id);

    // invitee survives with a nulled inviter (optional FK → SetNull).
    expect((await prisma.user.findUnique({ where: { id: invitee.id } }))?.invitedById).toBeNull();
    // The deleted user's audit row survives — actorId is free-text, not an FK.
    const prior = await prisma.auditLog.findFirst({ where: { action: "test.prior" } });
    expect(prior?.actorId).toBe(inviter.id);
  });
});
