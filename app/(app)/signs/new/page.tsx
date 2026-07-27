import Link from "next/link";

import { requirePageRole } from "@/lib/page-guards";
import { prisma } from "@/lib/db";
import { SYSTEM_TAG_SLUG_LIST } from "@/lib/tags";

import { createSign } from "../actions";
import { SignForm } from "../_components/SignForm";

export default async function NewSignPage() {
  await requirePageRole("lead", "/signs");

  const [zones, tags] = await Promise.all([
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: { id: true, zoneCode: true, zoneName: true, building: true },
    }),
    prisma.signTag.findMany({
      // System tags (e.g. `master-sheet`) aren't user-assignable (lib/tags.ts).
      where: { slug: { notIn: SYSTEM_TAG_SLUG_LIST } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">New sign</h1>
      </div>
      <SignForm
        action={createSign}
        zones={zones}
        tags={tags}
        submitLabel="Create sign"
      />
    </div>
  );
}
