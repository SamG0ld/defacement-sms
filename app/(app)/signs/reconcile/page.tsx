import Link from "next/link";

import { requirePageRole } from "@/lib/page-guards";

import { ReconcileWizard } from "./_components/ReconcileWizard";

// Applying a full-sheet resync is one round trip per changed row, chunked into 30s
// transactions (see APPLY_TX_OPTIONS / CHANGE_CHUNK in ./actions.ts). Route segment
// config covers the Server Actions invoked from this segment, so state it explicitly
// rather than inheriting the platform default — the same reason
// signs/generate/[id]/page.tsx pins it.
export const maxDuration = 300;

export default async function ReconcileSignsPage() {
  await requirePageRole("lead", "/signs");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Reconcile from the master sheet</h1>
        <p className="text-sm text-zinc-400">
          Upload the current sheet export (CSV) to see what changed since it was
          last imported. Only signs that came from the master sheet are compared,
          and only the <strong>printed sign text</strong> is ever updated — your
          sizes, notes, placement, and all deploy/QM state are left untouched, and
          nothing is ever deleted here.
        </p>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
        <summary className="cursor-pointer text-zinc-300">
          How reconcile decides
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>
            Only master-sheet signs are in scope. Standing (all-venue) signs and
            hand-added wayfinding are invisible here — never flagged, never touched.
          </li>
          <li>
            A sheet row is matched to a sign by its room + sheet Name (case- and
            whitespace-insensitive), keeping a room&apos;s sock separate from its
            main sign.
          </li>
          <li>
            <strong>Added</strong> — a space with no matching sign yet.{" "}
            <strong>Text change</strong> — a matched sign whose printed text differs
            (e.g. a sheet &ldquo;text should be X&rdquo; instruction).
          </li>
          <li>
            <strong>Department changes</strong> are informational only — a cue to
            re-decide that sign&apos;s size; nothing is applied.
          </li>
          <li>
            <strong>Removed</strong> and <strong>ambiguous</strong> rows are
            flagged for you to handle by hand — reconcile never deletes.
          </li>
        </ul>
      </details>

      <ReconcileWizard />
    </div>
  );
}
