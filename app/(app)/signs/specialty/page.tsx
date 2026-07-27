import Link from "next/link";

import { requirePageRole } from "@/lib/page-guards";
import { prisma } from "@/lib/db";

import { SpecialtyIntake } from "./_components/SpecialtyIntake";

export default async function SpecialtyIntakePage() {
  await requirePageRole("lead", "/signs");

  // Zones for the row grid + the next free auto item-ID number
  // (IDs follow the pattern EXT-NNN, three digits, zero-padded).
  const [zones, existingIds] = await Promise.all([
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: { id: true, zoneCode: true, zoneName: true, building: true },
    }),
    prisma.sign.findMany({
      where: { itemId: { startsWith: "EXT-" } },
      select: { itemId: true },
    }),
  ]);

  let nextNumber = 1;
  for (const sign of existingIds) {
    const match = sign.itemId.match(/^EXT-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= nextNumber) nextNumber = num + 1;
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Specialty intake</h1>
        <p className="text-xs text-zinc-500">
          Bulk-add externally-produced install items — graphics, vinyls, banners,
          sticker walls, selfie banners, venue maps. They enter the delivery →
          handoff → installed lifecycle automatically.
        </p>
      </div>
      <SpecialtyIntake zones={zones} nextNumber={nextNumber} />
    </div>
  );
}
