// DB lookups backing the sign-status authorization policy (lib/sign-status-authz).
// Kept separate from the pure policy so that module stays unit-testable without a
// database.

import { prisma } from "@/lib/db";

// Does the actor belong to the crew that holds this sign's claim?
export async function actorHoldsClaim(
  userId: string,
  claimedByCrewId: number | null,
): Promise<boolean> {
  if (claimedByCrewId === null) return false;
  const member = await prisma.crewMember.findUnique({
    where: { crewId_userId: { crewId: claimedByCrewId, userId } },
    select: { userId: true },
  });
  return member !== null;
}

// The crew ids the actor currently belongs to — for the bulk path's claim filter.
export async function actorCrewIds(userId: string): Promise<number[]> {
  const rows = await prisma.crewMember.findMany({
    where: { userId },
    select: { crewId: true },
  });
  return rows.map((r) => r.crewId);
}
