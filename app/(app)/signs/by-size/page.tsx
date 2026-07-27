import Link from "next/link";

import { prisma } from "@/lib/db";
import { requirePageSession } from "@/lib/page-guards";
import { hasRole } from "@/lib/rbac";
import { isValidFigmaUrl } from "@/lib/figma";
import { findResizeDrift, type DriftBatch } from "@/lib/sign-audit";
import {
  formatBucketForSize,
  formatBucketOrder,
} from "@/lib/sign-format";
import type { SignStatus } from "@/app/generated/prisma/client";

import {
  SIGN_STATUSES,
  STATUS_LABELS,
  buildSignWhere,
  statusBadgeClass,
} from "../_lib";
import { ManifestPanel } from "./_components/ManifestPanel";

// Authenticated, per-user, live record — never cache it.
export const dynamic = "force-dynamic";

type BucketView = {
  key: string;
  label: string;
  order: number;
  total: number;
  counts: Map<SignStatus, number>;
  figmaUrls: string[];
};

export default async function BySizePage() {
  const session = await requirePageSession();
  const canManage = hasRole(session.user.role, "lead");

  // Active record only (buildSignWhere default excludes archived), test data
  // excluded. This page drives print-run decisions, so it has to agree with the
  // other two surfaces that read the per-size record: both CSV exports already
  // drop test data (#225), and so does the reconcile manifest below it
  // (_manifest.ts). Leaving it in here inflated a size bucket by a stray "Import
  // as test data" row — a wrong print count (#267). The filter is applied here
  // rather than in buildSignWhere on purpose: the /signs list intentionally SHOWS
  // test data so it can be seen and cleared. Resize drift below is computed off
  // these same rows, so it follows automatically.
  //
  // One flat read; we bucket + tally in memory so the grouping stays in one place
  // (formatBucketForSize).
  const rows = await prisma.sign.findMany({
    where: { ...buildSignWhere({}), isTestData: false },
    select: {
      id: true,
      itemId: true,
      size: true,
      status: true,
      generationBatchId: true,
      generationBatch: { select: { figmaUrl: true } },
    },
    orderBy: [{ itemId: "asc" }, { id: "asc" }],
  });

  // Group into format buckets.
  const buckets = new Map<string, BucketView>();
  for (const r of rows) {
    const b = formatBucketForSize(r.size);
    let view = buckets.get(b.key);
    if (!view) {
      view = {
        key: b.key,
        label: b.label,
        order: formatBucketOrder(b.key),
        total: 0,
        counts: new Map(),
        figmaUrls: [],
      };
      buckets.set(b.key, view);
    }
    view.total += 1;
    view.counts.set(r.status, (view.counts.get(r.status) ?? 0) + 1);
    const url = r.generationBatch?.figmaUrl;
    if (url && isValidFigmaUrl(url) && !view.figmaUrls.includes(url)) {
      view.figmaUrls.push(url);
    }
  }
  const bucketViews = [...buckets.values()].sort((a, b) => a.order - b.order);

  // Resize drift (MOVE): batch-aware, computed off the same rows. A sign whose current
  // bucket differs from its generation batch's plurality bucket moved size after render.
  const byBatch = new Map<number, DriftBatch>();
  for (const r of rows) {
    if (r.generationBatchId == null) continue;
    let db = byBatch.get(r.generationBatchId);
    if (!db) {
      db = { batchId: r.generationBatchId, signs: [] };
      byBatch.set(r.generationBatchId, db);
    }
    db.signs.push({ id: r.id, itemId: r.itemId, size: r.size });
  }
  const drift = findResizeDrift([...byBatch.values()]);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Link href="/signs" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All signs
        </Link>
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[24px] font-extrabold tracking-tight">
            Record by size
          </h1>
          <span className="font-mono text-[12px]" style={{ color: "var(--zinc-500)" }}>
            {rows.length} active
          </span>
        </div>
        <p className="text-sm text-zinc-400">
          The complete record of active signs for each size, across every generation
          batch. {canManage
            ? "Generate a reconcile manifest to see exactly which Figma nodes to delete or which signs still need rendering — the app never edits Figma, it lists the work."
            : "Ask a lead to reconcile a size against its Figma file."}
        </p>
      </div>

      {drift.length > 0 && (
        <div className="rounded-lg border border-violet-900 bg-violet-950/40 px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.06em] text-violet-300">
            Resized after generation ({drift.length})
          </div>
          <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-300">
            {drift.map((d) => (
              <li key={d.signId}>
                <span className="font-mono">{d.itemId}</span> moved{" "}
                <span className="text-zinc-400">{d.from}</span> →{" "}
                <span className="text-zinc-200">{d.to}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-zinc-500">
            The manifest handles these automatically — the moved node shows as a delete in
            the old size&apos;s file and an append in the new size&apos;s.
          </p>
        </div>
      )}

      {bucketViews.length === 0 && (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-6 text-sm text-zinc-400">
          No active signs yet.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {bucketViews.map((b) => (
          <div
            key={b.key}
            className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-bold">{b.label}</h2>
              <span className="font-mono text-[12px]" style={{ color: "var(--zinc-500)" }}>
                {b.total}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {SIGN_STATUSES.filter((s) => (b.counts.get(s) ?? 0) > 0).map((s) => (
                <span
                  key={s}
                  className={`rounded border px-2 py-0.5 text-[11px] ${statusBadgeClass(s)}`}
                >
                  {STATUS_LABELS[s]} {b.counts.get(s)}
                </span>
              ))}
            </div>

            <div className="mt-3 text-[11px] text-zinc-400">
              {b.figmaUrls.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-zinc-500">Figma:</span>
                  {b.figmaUrls.map((u, i) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sky-400 hover:text-sky-300"
                    >
                      file {i + 1}
                    </a>
                  ))}
                </div>
              ) : (
                <span className="text-zinc-500">No Figma file linked yet.</span>
              )}
            </div>

            {canManage && (
              <ManifestPanel bucketKey={b.key} bucketLabel={b.label} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
