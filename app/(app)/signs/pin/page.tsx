import Link from "next/link";

import { requirePageRole } from "@/lib/page-guards";
import { getEnabledFloorMaps } from "@/lib/floor-maps";

import { AutoPinWizard } from "./_components/AutoPinWizard";

export default async function AutoPinPage() {
  await requirePageRole("admin", "/signs");
  const maps = await getEnabledFloorMaps();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Auto-pin by room code</h1>
        <p className="text-sm text-zinc-400">
          Match signs to registry rooms by their room code, in one pass. Rooms that
          don&apos;t exist yet are created on the floor you map their code to; rooms
          that exist but aren&apos;t on a current map are re-homed. Then you place
          each room once on the <Link href="/map" className="underline hover:text-zinc-200">Map</Link> and
          every sign in it inherits the pin. Preview first — nothing is written until
          you apply.
        </p>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
        <summary className="cursor-pointer text-zinc-300">How auto-pin decides</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>
            Signs are matched on their printed <strong>Room</strong> code, normalized
            so spelling variants (&ldquo;W204, W205&rdquo; = &ldquo;W204-W205&rdquo;)
            collapse to one.
          </li>
          <li>
            <strong>Link</strong> — the room already exists. <strong>Create + link</strong> —
            no room yet, but the code maps to a floor, so a room is created there.
          </li>
          <li>
            The <strong>prefix → map</strong> table below decides which floor a
            created / re-homed room lives on (the new maps aren&apos;t zone-linked, so
            the code picks the map). Edit it to fit this year&apos;s codes.
          </li>
          <li>
            <strong>Range</strong> codes (&ldquo;1400-1402&rdquo;) and{" "}
            <strong>unmatched</strong> (villages, blanks) are left for you to place by
            hand — never auto-created.
          </li>
          <li>
            Signs you&apos;ve already placed or linked are left untouched unless you
            explicitly opt in to overwrite them.
          </li>
        </ul>
      </details>

      <AutoPinWizard maps={maps.map((m) => ({ key: m.key, label: m.label }))} />
    </div>
  );
}
