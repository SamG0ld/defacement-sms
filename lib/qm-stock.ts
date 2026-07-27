import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { signIdentitySelect, type SignIdentity } from "@/lib/stock";

// Shared QM-group query helpers. A "group" is the set of identical signs sharing the
// identity key (lib/stock SignIdentity — physical fields + placement, status
// excluded); "remaining at QM" for a group = its rows where qmTakenAt IS NULL. Used
// by the take/return action (signs/stock-actions.ts), the sign detail page, and the
// inventory QM rollup so the grouping is defined in exactly one place.

// Anything with a $queryRaw — both the PrismaClient singleton and a $transaction
// client satisfy this, so callers pass whichever they hold.
type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

// SQL predicate selecting every row in a representative's group. IS NOT DISTINCT
// FROM matches NULL = NULL so the all-venue pile (null zone/slot) groups correctly.
// The SignCategory enum needs an explicit cast on the bound text value.
export function buildGroupWhere(rep: SignIdentity): Prisma.Sql {
  return Prisma.sql`
    sign_text = ${rep.signText}
    AND sign_type = ${rep.signType}
    AND size = ${rep.size}
    AND category = ${rep.category}::"SignCategory"
    AND double_sided = ${rep.doubleSided}
    AND needs_easel = ${rep.needsEasel}
    AND printable = ${rep.printable}
    AND zone_id IS NOT DISTINCT FROM ${rep.zoneId}
    AND deployment_slot IS NOT DISTINCT FROM ${rep.deploymentSlot}
    -- Soft-removed signs are out of the record entirely, so they never count
    -- toward a QM pile's total/remaining (buildSignWhere excludes them for the
    -- Prisma paths; this raw group query needs the exclusion spelled out).
    AND status <> 'archived'::"SignStatus"`;
}

export type GroupCounts = { total: number; taken: number; remaining: number };

// Total rows and taken (qmTakenAt non-null) rows for a group. ::int keeps COUNT in
// the JS number range (Prisma maps Postgres int8 to bigint otherwise).
export async function countGroup(
  client: RawClient,
  groupWhere: Prisma.Sql,
): Promise<GroupCounts> {
  const rows = await client.$queryRaw<{ total: number; taken: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS total, COUNT(qm_taken_at)::int AS taken
    FROM signs WHERE ${groupWhere}`);
  const total = Number(rows[0]?.total ?? 0);
  const taken = Number(rows[0]?.taken ?? 0);
  return { total, taken, remaining: total - taken };
}

// Group counts for the group a given sign belongs to (sign detail page). null if
// the sign doesn't exist.
export async function countGroupForSign(
  signId: number,
): Promise<GroupCounts | null> {
  const rep = await prisma.sign.findUnique({
    where: { id: signId },
    select: signIdentitySelect,
  });
  if (!rep) return null;
  return countGroup(prisma, buildGroupWhere(rep));
}

export type QmGroupRow = {
  // A representative member's id — passed to the take/return action, which derives
  // the whole group from it (copies are interchangeable). It is the id of the row
  // whose itemId is shown below and which sets the group's list position, so the
  // three never disagree (#242).
  repId: number;
  itemId: string;
  signText: string;
  size: string;
  total: number;
  taken: number;
  remaining: number;
};

// Every QM pile — groups of identical signs with more than one member — with their
// Total / Out / Remaining counts, ordered like the signs list. One scan; the
// HAVING drops unique signs (the 284 DC34 spaces) so only piles show.
export async function listQmGroups(): Promise<QmGroupRow[]> {
  const rows = await prisma.$queryRaw<
    {
      rep_id: number;
      item_id: string;
      sign_text: string;
      size: string;
      total: number;
      taken: number;
    }[]
  >(Prisma.sql`
    SELECT
      -- One representative row drives all three of: the shown item_id, the group's
      -- sort position, and repId. Picking it by (item_id, id) makes the displayed
      -- item_id the same MIN(item_id) the ORDER BY sorts on, and repId that row's
      -- own id (#242). The trailing id is a required tiebreak — signs.item_id is
      -- indexed but NOT unique, and a QM pile's copies routinely share one.
      (ARRAY_AGG(id ORDER BY item_id, id))[1]::int AS rep_id,
      MIN(item_id) AS item_id,
      sign_text,
      size,
      COUNT(*)::int AS total,
      COUNT(qm_taken_at)::int AS taken
    FROM signs
    -- Soft-removed signs are out of the record, so they never form or count
    -- toward a QM pile (mirrors buildGroupWhere's per-sign exclusion).
    WHERE status <> 'archived'::"SignStatus"
    GROUP BY sign_text, sign_type, size, category, double_sided, needs_easel, printable, zone_id, deployment_slot
    HAVING COUNT(*) > 1
    ORDER BY MIN(deployment_priority), MIN(item_id)`);
  return rows.map((r) => {
    const total = Number(r.total);
    const taken = Number(r.taken);
    return {
      repId: Number(r.rep_id),
      itemId: r.item_id,
      signText: r.sign_text,
      size: r.size,
      total,
      taken,
      remaining: total - taken,
    };
  });
}
