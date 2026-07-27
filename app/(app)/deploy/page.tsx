import { prisma } from "@/lib/db";
import { requirePageSession } from "@/lib/page-guards";
import type { SignStatus } from "@/app/generated/prisma/client";

import { ARCHIVED_STATUS } from "../signs/_lib";
import { DeployApp } from "./_components/DeployApp";
import {
  ZoneDeployOverview,
  type ZoneProgress,
} from "./_components/ZoneDeployOverview";
import { countUnzonedSigns } from "./_overview";

// "Deployed" = the two up terminals, mirroring the dashboard/top-strip telemetry
// (a sign is deployed by us OR installed externally).
const DEPLOYED = new Set<SignStatus>(["deployed", "installed"]);

// Field deployment tool — the installable PWA's home (manifest start_url). Lives
// under (app) so the same auth gate as the rest of the app applies. All floor
// state is client-side and offline-first (DeployApp, see _lib/store.ts), fed by
// the /api/native/* JSON API. The server additionally computes a read-only
// per-zone deployment overview shown only on desktop (the mobile field flow
// stays first + full-bleed); the gauge is zone-scoped (signs without a zone
// aren't counted — by con time every sign should be zoned).
export default async function DeployPage() {
  const session = await requirePageSession();

  const [zones, grouped] = await Promise.all([
    prisma.zone.findMany({
      where: { isActive: true },
      select: { id: true, zoneCode: true, zoneName: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneName: "asc" }],
    }),
    // Archived (soft-removed) signs are excluded so a removed sign can't sit in a
    // zone's denominator forever — it lands in perZoneTotal but never in
    // perZoneDeployed, so the zone could never read 100%. This groupBy doesn't run
    // through buildSignWhere, so the exclusion is explicit here (same as the
    // dashboard's telemetry groupBy in app/(app)/page.tsx).
    prisma.sign.groupBy({
      by: ["zoneId", "status"],
      _count: { _all: true },
      where: { status: { not: ARCHIVED_STATUS } },
    }),
  ]);

  const perZoneTotal = new Map<number, number>();
  const perZoneDeployed = new Map<number, number>();
  for (const g of grouped) {
    if (g.zoneId === null) continue;
    const n = g._count._all;
    perZoneTotal.set(g.zoneId, (perZoneTotal.get(g.zoneId) ?? 0) + n);
    if (DEPLOYED.has(g.status)) {
      perZoneDeployed.set(g.zoneId, (perZoneDeployed.get(g.zoneId) ?? 0) + n);
    }
  }

  const zoneProgress: ZoneProgress[] = zones
    .map((z) => ({
      code: z.zoneCode,
      label: z.zoneName,
      deployed: perZoneDeployed.get(z.id) ?? 0,
      total: perZoneTotal.get(z.id) ?? 0,
    }))
    // An empty zone (no signs) isn't deployment work — drop it from the readout.
    .filter((z) => z.total > 0);

  const deployed = zoneProgress.reduce((s, z) => s + z.deployed, 0);
  const total = zoneProgress.reduce((s, z) => s + z.total, 0);

  // Signs with no zone are excluded from the gauge above (by design) — surface
  // the count so this zone-scoped x/y visibly reconciles with the fleet-wide
  // top-strip DEPLOY readout, which counts them. Computed off the same rows,
  // without altering the zone-progress math.
  const unzoned = countUnzonedSigns(grouped);

  return (
    <div className="space-y-4">
      {/* Desktop-only ops overview; the mobile field flow stays first/full-bleed. */}
      <div className="hidden md:block">
        <ZoneDeployOverview
          deployed={deployed}
          total={total}
          zones={zoneProgress}
          unzoned={unzoned}
        />
      </div>
      <DeployApp currentUserId={session.user.id} />
    </div>
  );
}
