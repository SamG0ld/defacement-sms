// #226 / #178: the /deploy desktop zone gauge is fed by ONE groupBy in the page. It
// doesn't run through buildSignWhere, so the archived (soft-removed) exclusion has to be
// explicit there — otherwise a removed sign sits in a zone's denominator forever and the
// zone can never read 100%. Asserted at the page level because the query IS the fix; the
// downstream fold (_overview.ts) is already unit-tested and unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import DeployPage from "@/app/(app)/deploy/page";
import { ZoneDeployOverview } from "@/app/(app)/deploy/_components/ZoneDeployOverview";

type OverviewProps = {
  deployed: number;
  total: number;
  zones: { code: string; deployed: number; total: number }[];
  unzoned?: number;
};

// Walk the page's element tree for the (server-rendered) overview and read its props.
// Nothing is rendered — no hook runs — so the client DeployApp beside it stays inert.
function findOverviewProps(node: unknown): OverviewProps | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findOverviewProps(child);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === ZoneDeployOverview) return el.props as unknown as OverviewProps;
  return el.props ? findOverviewProps(el.props.children) : null;
}

async function seedZoneSigns(zoneId: number) {
  const base = {
    signType: '22"x28"',
    size: "22x28",
    zoneId,
  };
  await prisma.sign.create({
    data: { ...base, itemId: "D-1", signText: "Deployed", status: "deployed" as never },
  });
  await prisma.sign.create({
    data: { ...base, itemId: "RM-1", signText: "Removed", status: "archived" as never },
  });
}

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("/deploy zone gauge", () => {
  it("excludes archived signs from a zone's total, so a fully-deployed zone reads 100%", async () => {
    const zone = await prisma.zone.findFirstOrThrow({ where: { isActive: true } });
    await seedZoneSigns(zone.id);

    const props = findOverviewProps(await DeployPage());
    expect(props).not.toBeNull();
    const z = props!.zones.find((x) => x.code === zone.zoneCode);
    expect(z).toBeDefined();
    // 1 deployed / 1 total — the archived row is not outstanding work.
    expect(z!.total).toBe(1);
    expect(z!.deployed).toBe(1);
    expect(props!.total).toBe(1);
    expect(props!.deployed).toBe(1);
  });

  it("excludes archived signs from the unzoned caption too", async () => {
    // countUnzonedSigns folds the same rows, so it inherits the filter.
    await prisma.sign.create({
      data: {
        itemId: "U-1",
        signText: "Unzoned removed",
        signType: '22"x28"',
        size: "22x28",
        status: "archived" as never,
      },
    });
    const zone = await prisma.zone.findFirstOrThrow({ where: { isActive: true } });
    await seedZoneSigns(zone.id);

    const props = findOverviewProps(await DeployPage());
    expect(props).not.toBeNull();
    expect(props!.unzoned).toBe(0);
  });
});
