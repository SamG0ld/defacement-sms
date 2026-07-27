import Link from "next/link";

import { requirePageRole } from "@/lib/page-guards";

import { ImportWizard } from "./_components/ImportWizard";

export default async function ImportSignsPage() {
  await requirePageRole("lead", "/signs");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Import signs from CSV</h1>
        <p className="text-sm text-zinc-400">
          Upload a CSV to preview before anything is written. Nothing is deleted —
          rows are added, and likely-duplicates are flagged so you don&apos;t
          double-load.
        </p>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
        <summary className="cursor-pointer text-zinc-300">
          Recognized columns
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>
            <strong>Required:</strong> Item ID / Map#, Sign Text
          </li>
          <li>
            <strong>Optional:</strong> Type, Size (or Material), Qty, Location,
            Easel, Zone (zone code), Tags (comma/semicolon-separated), Deploy
            Slot, Notes
          </li>
          <li>
            Headers are matched case-insensitively. Unknown zones/tags and
            unrecognized deploy slots are flagged as warnings, not errors.
          </li>
        </ul>
      </details>

      <ImportWizard />
    </div>
  );
}
