import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/rbac";

import { createSign } from "../actions";
import { SignForm } from "../_components/SignForm";

export default async function NewSignPage() {
  const session = await getSession();
  if (!session?.user?.role || !hasRole(session.user.role, "lead")) {
    redirect("/signs");
  }

  const [zones, tags] = await Promise.all([
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: { id: true, zoneCode: true, zoneName: true, building: true },
    }),
    prisma.signTag.findMany({
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
