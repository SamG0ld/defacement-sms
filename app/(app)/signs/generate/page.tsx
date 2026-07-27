import Link from "next/link";

import { prisma } from "@/lib/db";
import { requirePageRole } from "@/lib/page-guards";

import { formatDateTime } from "../_lib";
import { DeleteBatchButton } from "./_DeleteBatchButton";

type Props = { searchParams: Promise<{ error?: string }> };

// Generation index (lead+): the sign-generation batches. Each batch is a set of
// signs handed off to Figma — download its render-ready CSV, generate in Figma,
// then paste the Figma file link back in on the batch page.
export default async function GenerationIndexPage({ searchParams }: Props) {
  await requirePageRole("lead", "/signs");
  const { error } = await searchParams;

  const batches = await prisma.generationBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      label: true,
      pipeline: true,
      figmaUrl: true,
      signCount: true,
      createdByEmail: true,
      createdById: true,
      createdAt: true,
      _count: { select: { signs: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <h1 className="text-2xl font-semibold">Generation</h1>
        <p className="text-sm text-zinc-400">
          Sign-generation batches. Each batch is a set of signs handed off to
          Figma; download its render-ready CSV, then paste the Figma file link
          back in.
        </p>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error.slice(0, 300)}
        </p>
      )}

      {batches.length === 0 ? (
        <p className="max-w-2xl text-sm text-zinc-500">
          No batches yet. Go to the{" "}
          <Link href="/signs" className="text-accent hover:opacity-80">
            signs list
          </Link>
          , tick the checkboxes for the signs you want, then click{" "}
          <span className="text-zinc-300">Generate</span> in the action bar that
          appears at the bottom of the page.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Signs</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2">Pipeline</th>
                <th className="px-3 py-2">Figma</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-zinc-900 hover:bg-zinc-900/50"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/signs/generate/${b.id}`}
                      className="text-accent hover:opacity-80"
                    >
                      {b.label ?? `Batch #${b.id}`}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    {b._count.signs}
                    {b._count.signs !== b.signCount ? ` / ${b.signCount}` : ""}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">
                    {formatDateTime(b.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">
                    {b.createdByEmail ?? b.createdById}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{b.pipeline}</td>
                  <td className="px-3 py-2">
                    {b.figmaUrl ? (
                      <a
                        href={b.figmaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:opacity-80"
                      >
                        open ↗
                      </a>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <DeleteBatchButton
                        batchId={b.id}
                        signCount={b._count.signs}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
