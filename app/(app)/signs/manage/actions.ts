"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { checkMutationRateLimit } from "@/lib/ratelimit";

const CONFIRM_PHRASE = "DELETE ALL SIGNS";

function fail(message: string): never {
  redirect(`/signs/manage?error=${encodeURIComponent(message)}`);
}
function done(message: string): never {
  redirect(`/signs/manage?done=${encodeURIComponent(message)}`);
}

// Wipe only sample/test signs (isTestData=true) — the seeded samples plus any
// import done with the "Import as test data" toggle on. Cascade clears their
// status history + tag assignments. The final list (isTestData=false) is safe.
export async function clearTestSigns(): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");

  const { count } = await prisma.sign.deleteMany({
    where: { isTestData: true },
  });

  await recordAudit({
    action: "signs.clear_test",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Deleted ${count} test sign${count === 1 ? "" : "s"}`,
  });

  revalidatePath("/signs");
  revalidatePath("/signs/manage");
  done(`Deleted ${count} test sign${count === 1 ? "" : "s"}.`);
}

// Nuclear reset: delete EVERY sign regardless of flag. Gated behind an exact
// typed phrase so it can't be a misclick.
export async function clearAllSigns(formData: FormData): Promise<void> {
  const session = await requireRole("admin");
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) fail("Too many changes at once. Please wait a moment.");

  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== CONFIRM_PHRASE) {
    fail(`Type "${CONFIRM_PHRASE}" exactly to confirm.`);
  }

  const { count } = await prisma.sign.deleteMany({});

  await recordAudit({
    action: "signs.clear_all",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Deleted ${count} sign${count === 1 ? "" : "s"} (all)`,
  });

  revalidatePath("/signs");
  revalidatePath("/signs/manage");
  done(`Deleted all ${count} sign${count === 1 ? "" : "s"}.`);
}
