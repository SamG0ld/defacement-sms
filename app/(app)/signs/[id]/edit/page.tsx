import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/rbac";

import { updateSign } from "../../actions";
import { SignForm } from "../../_components/SignForm";

type Params = Promise<{ id: string }>;

export default async function EditSignPage({ params }: { params: Params }) {
  const session = await getSession();
  if (!session?.user?.role || !hasRole(session.user.role, "lead")) {
    redirect("/signs");
  }

  const { id } = await params;
  const signId = Number.parseInt(id, 10);
  if (!Number.isInteger(signId)) notFound();

  const [sign, zones, tags] = await Promise.all([
    prisma.sign.findUnique({
      where: { id: signId },
      include: { tagAssignments: { select: { tagId: true } } },
    }),
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
  if (!sign) notFound();

  const selectedTagIds = sign.tagAssignments.map((a) => a.tagId);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/signs/${sign.id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← Back to sign
        </Link>
        <h1 className="text-2xl font-semibold">Edit {sign.itemId}</h1>
      </div>
      <SignForm
        action={updateSign.bind(null, sign.id)}
        zones={zones}
        tags={tags}
        sign={sign}
        selectedTagIds={selectedTagIds}
        submitLabel="Save changes"
      />
    </div>
  );
}
