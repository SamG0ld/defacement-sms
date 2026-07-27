"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { checkMutationRateLimit } from "@/lib/ratelimit";
import { requireSession } from "@/lib/rbac";
import { buildGroupWhere, countGroup } from "@/lib/qm-stock";
import {
  serializeGroupKey,
  signIdentitySelect,
  stockInputSchema,
  type StockInput,
  type StockResult,
} from "@/lib/stock";

// ---------------------------------------------------------------------------
// QM stock check-out. Bulk signs (Code of Conduct ×10, Hotline ×20, …) are stored
// as individual qty-1 rows; the UI collapses identical rows into one group. A
// batch take/return flips the per-row `qmTakenAt` flag on N pool members of that
// group, so "remaining at QM" = the group's rows where qmTakenAt IS NULL. Open to
// any active user (a QM-desk action, not destructive — same posture as the deploy /
// lifecycle actions). Correctness rests on two independent guards:
//   • a single UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE) flips exactly N
//     untaken rows atomically; the row lock serializes concurrent takes so the
//     second one re-evaluates against committed state and can never over-take
//     (plain FOR UPDATE, not SKIP LOCKED, so all-or-nothing batches don't both
//     fail by splitting the pool);
//   • a unique clientId makes an at-least-once replay (double-tap / offline drain)
//     exactly-once — checked inside the tx, with a P2002 catch as the backstop.
// Mirrors the FOR UPDATE idiom in signs/lifecycle-actions.ts and the clientId
// ledger in lib/deploy/service.ts.
// ---------------------------------------------------------------------------

// Thrown inside the transaction when fewer than N pool rows are available, so the
// partial flip rolls back atomically. `available` is how many actually existed
// (== the rows we managed to flip before rolling back).
class InsufficientStock extends Error {
  constructor(
    readonly available: number,
    readonly direction: 1 | -1,
  ) {
    super("insufficient_stock");
  }
}

async function applyStockDelta(
  input: StockInput,
  direction: 1 | -1,
): Promise<StockResult> {
  const session = await requireSession();

  const parsed = stockInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid stock request.",
    };
  }
  const { signId, n, clientId, note } = parsed.data;

  // Per-actor backstop (60/min) — this is open to every active user, so there's
  // no role gate to lean on as a throttle.
  const budget = await checkMutationRateLimit(session.user.id);
  if (!budget.success) {
    return {
      ok: false,
      error: "Too many changes at once — wait a minute and try again.",
    };
  }

  const delta = direction * n;
  const actorEmail = session.user.email ?? null;
  const actorRef = actorEmail ?? session.user.id;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Representative row → the group's identity. Not locked: identity fields are
      // stable; the candidate pool rows are locked by the UPDATE below.
      const rep = await tx.sign.findUnique({
        where: { id: signId },
        select: signIdentitySelect,
      });
      if (!rep) return { ok: false as const, error: "Sign not found." };

      const groupKey = serializeGroupKey(rep);
      const groupWhere = buildGroupWhere(rep);
      const pre = await countGroup(tx, groupWhere);

      // Only a pile (a group of identical signs) is tracked at QM. Re-assert it
      // server-side so a hand-crafted POST can't flip the flag on a unique sign —
      // mirrors the UI gate (group size > 1) and the #112 quantity-based guard.
      if (pre.total <= 1) {
        return { ok: false as const, error: "This sign isn't tracked at QM." };
      }

      // Idempotency: a prior submit with this clientId already landed. No-op, but
      // report the current group counts (pre — no flip happened) so the client
      // reconciles to the same value.
      const dup = await tx.signStockCheckout.findUnique({
        where: { clientId },
        select: { id: true },
      });
      if (dup) {
        return {
          ok: true as const,
          replayed: true as const,
          taken: pre.taken,
          remaining: pre.remaining,
        };
      }

      // Atomically lock + flip exactly N pool rows in id order. Plain FOR UPDATE
      // (not SKIP LOCKED): a concurrent take blocks on the lowest locked row, then
      // re-evaluates qm_taken_at against committed state — so two batches can't both
      // fail by splitting the pool, and neither over-takes. RETURNING gives the ids
      // for cache revalidation.
      const takenClause =
        direction === 1
          ? Prisma.sql`qm_taken_at IS NULL`
          : Prisma.sql`qm_taken_at IS NOT NULL`;
      const setClause =
        direction === 1
          ? Prisma.sql`qm_taken_at = NOW(), qm_taken_by = ${actorRef}`
          : Prisma.sql`qm_taken_at = NULL, qm_taken_by = NULL`;
      const flipped = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        UPDATE signs SET ${setClause}
        WHERE id IN (
          SELECT id FROM signs
          WHERE ${groupWhere} AND ${takenClause}
          ORDER BY id
          LIMIT ${n}
          FOR UPDATE
        )
        RETURNING id`);

      // Fewer than N available — throw to roll the partial flip back atomically.
      // The count we managed to flip IS how many were available, so no re-count.
      if (flipped.length < n) {
        throw new InsufficientStock(flipped.length, direction);
      }

      await tx.signStockCheckout.create({
        data: {
          clientId,
          groupKey,
          delta,
          byUserId: session.user.id,
          byEmail: actorEmail,
          note: note ?? null,
        },
      });

      const counts = await countGroup(tx, groupWhere);
      return {
        ok: true as const,
        replayed: false as const,
        taken: counts.taken,
        remaining: counts.remaining,
        total: counts.total,
        signText: rep.signText,
        flippedIds: flipped.map((r) => r.id),
      };
    });

    if (result.ok) {
      if (!result.replayed) {
        // Best-effort audit (recordAudit swallows its own failures).
        await recordAudit({
          action: "sign.stock",
          actorId: session.user.id,
          actorEmail,
          detail: `QM "${result.signText}" (×${result.total}) ${delta > 0 ? "+" : ""}${delta} → ${result.remaining} left at QM`,
        });
        for (const id of result.flippedIds) revalidatePath(`/signs/${id}`);
      }
      revalidatePath("/signs");
      revalidatePath(`/signs/${signId}`);
      // The inventory page's QM rollup reads the same flags — keep it fresh.
      revalidatePath("/inventory");
      return { ok: true, taken: result.taken, remaining: result.remaining };
    }
    return result;
  } catch (err) {
    // Not enough on the pile — the partial flip rolled back; report the real count.
    if (err instanceof InsufficientStock) {
      return {
        ok: false,
        error:
          err.direction === 1
            ? `Only ${err.available} left at QM.`
            : `Only ${err.available} are checked out.`,
      };
    }
    // A concurrent replay of the SAME clientId committed first; the unique index
    // rolled this whole tx back. Honest idempotency — re-read the committed group
    // counts and report the reconciled value.
    // The violated-fields list moved under the pg driver adapter: classic engines
    // report it at meta.target; adapter-pg nests it at
    // meta.driverAdapterError.cause.constraint.fields (meta.target is absent).
    // Check both shapes — the old target-only guard silently never matched, so
    // this path rethrew a raw P2002 at the caller (caught by the #131 race test).
    const uniqueFields =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
        ? ((err.meta?.target ??
            (
              err.meta as {
                driverAdapterError?: {
                  cause?: { constraint?: { fields?: string[] } };
                };
              }
            )?.driverAdapterError?.cause?.constraint?.fields) as
            | string[]
            | string
            | undefined)
        : undefined;
    if (
      Array.isArray(uniqueFields)
        ? uniqueFields.includes("client_id")
        : typeof uniqueFields === "string" && uniqueFields.includes("client_id")
    ) {
      const reconciled = await prisma.$transaction(async (tx) => {
        const rep = await tx.sign.findUnique({
          where: { id: signId },
          select: signIdentitySelect,
        });
        if (!rep) return null;
        return countGroup(tx, buildGroupWhere(rep));
      });
      return reconciled
        ? { ok: true, taken: reconciled.taken, remaining: reconciled.remaining }
        : { ok: false, error: "Sign not found." };
    }
    throw err;
  }
}

// Take `n` signs of this group from the QM pile (remaining drops by n).
export async function takeFromQm(input: StockInput): Promise<StockResult> {
  return applyStockDelta(input, 1);
}

// Return `n` signs of this group to the QM pile (remaining rises by n).
export async function returnToQm(input: StockInput): Promise<StockResult> {
  return applyStockDelta(input, -1);
}
