import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePageRole } from "@/lib/page-guards";
import { prisma } from "@/lib/db";
import { SYSTEM_TAG_SLUG_LIST } from "@/lib/tags";

import { updateSign } from "../../actions";
import { SignForm } from "../../_components/SignForm";

type Params = Promise<{ id: string }>;

export default async function EditSignPage({ params }: { params: Params }) {
  await requirePageRole("lead", "/signs");

  const { id } = await params;
  const signId = Number.parseInt(id, 10);
  if (!Number.isInteger(signId)) notFound();

  const [sign, zones, tags] = await Promise.all([
    prisma.sign.findUnique({
      where: { id: signId },
      include: { tagAssignments: { select: { tagId: true } } },
    }),
    // Active zones PLUS this sign's own zone even if it has since been
    // deactivated: without it the <select> has no option matching the sign's
    // zoneId, falls back to "— none —", and saving any unrelated field silently
    // clears the placement. The relation filter keeps this one query (and inside
    // the Promise.all) rather than serialising behind the sign fetch.
    prisma.zone.findMany({
      where: { OR: [{ isActive: true }, { signs: { some: { id: signId } } }] },
      orderBy: [{ deploymentPriority: "asc" }, { zoneCode: "asc" }],
      select: {
        id: true,
        zoneCode: true,
        zoneName: true,
        building: true,
        isActive: true,
      },
    }),
    prisma.signTag.findMany({
      // System tags (e.g. `master-sheet`) aren't user-assignable (lib/tags.ts); they
      // stay put across an edit because updateSign preserves them (see actions.ts).
      where: { slug: { notIn: SYSTEM_TAG_SLUG_LIST } },
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
