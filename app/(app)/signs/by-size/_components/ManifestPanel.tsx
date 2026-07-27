"use client";

import { useState, useTransition } from "react";

import { generateBucketManifest } from "../actions";
import type { BucketManifest } from "../_manifest";

// Lead-only island: generate + preview the reconcile manifest for one size bucket, and
// offer the same manifest as a JSON download. Read-only against Figma — the copy makes
// the boundary explicit so no one thinks pressing this touched the file.
export function ManifestPanel({
  bucketKey,
  bucketLabel,
}: {
  bucketKey: string;
  bucketLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [manifest, setManifest] = useState<BucketManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateBucketManifest(bucketKey);
        if (result.ok) {
          setManifest(result.manifest);
        } else {
          setManifest(null);
          setError(result.error);
        }
      } catch {
        setManifest(null);
        setError("Couldn't generate the manifest. Try again.");
      }
    });
  };

  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={run}
          disabled={pending}
        >
          {pending ? "Reconciling…" : "Generate reconcile manifest"}
        </button>
        <a
          href={`/signs/by-size/manifest?bucket=${encodeURIComponent(bucketKey)}`}
          className="btn"
        >
          Download JSON
        </a>
        <span className="text-[11px] text-[var(--zinc-500)]">
          Lists deletes / appends — does <strong>not</strong> modify Figma.
        </span>
      </div>

      {error && (
        <div className="mt-2 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {manifest && (
        <div className="mt-3 space-y-3 text-xs">
          <div className="flex flex-wrap gap-2 font-mono text-[11px]">
            <Stat label="in file" value={manifest.counts.inFile} />
            <Stat label="delete" value={manifest.counts.deletes} tone="amber" />
            <Stat label="append" value={manifest.counts.appends} tone="sky" />
            <Stat
              label="correct"
              value={manifest.counts.corrections}
              tone="emerald"
            />
            <Stat label="stale" value={manifest.counts.orphans} tone="amber" />
            <Stat
              label="ambiguous"
              value={manifest.counts.ambiguous}
              tone="fuchsia"
            />
          </div>

          {manifest.fileErrors.length > 0 && (
            <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-red-200">
              {manifest.fileErrors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

          {manifest.counts.deletes > 0 && (
            <Section title={`Delete from Figma (${manifest.counts.deletes})`} tone="amber">
              {manifest.files.flatMap((f) =>
                f.deletes.map((d) => (
                  <li key={`${f.fileKey}:${d.nodeId}`} className="font-mono">
                    <span className="text-[var(--zinc-500)]">{d.nodeId}</span>{" "}
                    {d.nodeName}
                  </li>
                )),
              )}
            </Section>
          )}

          {manifest.counts.orphans > 0 && (
            <Section
              title={`Stale nodes — no active sign (delete?) (${manifest.counts.orphans})`}
              tone="amber"
            >
              {manifest.files.flatMap((f) =>
                f.orphanNodes.map((o) => (
                  <li key={`${f.fileKey}:${o.nodeId}`} className="font-mono">
                    <span className="text-[var(--zinc-500)]">{o.nodeId}</span>{" "}
                    {o.nodeName}
                  </li>
                )),
              )}
            </Section>
          )}

          {manifest.appends.length > 0 && (
            <Section title={`Not yet rendered — append (${manifest.appends.length})`} tone="sky">
              {manifest.appends.map((a) => (
                <li key={a.signId}>
                  <span className="font-mono">{a.itemId}</span> — {a.signText}
                </li>
              ))}
            </Section>
          )}

          {manifest.counts.corrections > 0 && (
            <Section
              title={`Corrections — update text in place (${manifest.counts.corrections})`}
              tone="emerald"
            >
              {manifest.files.flatMap((f) =>
                f.corrections.map((c) => (
                  <li key={`${f.fileKey}:${c.nodeId}`} className="font-mono">
                    <span className="text-[var(--zinc-500)]">{c.nodeId}</span>{" "}
                    {c.fromName} → {c.toName}
                  </li>
                )),
              )}
            </Section>
          )}

          {manifest.counts.ambiguous > 0 && (
            <Section
              title={`Ambiguous — resolve by hand (${manifest.counts.ambiguous})`}
              tone="fuchsia"
            >
              {manifest.ambiguousSigns.map((a, i) => (
                <li key={`sign:${i}`} className="font-mono">
                  {a.nodeName} — signs {a.signIds.join(", ")}
                </li>
              ))}
              {manifest.files.flatMap((f) =>
                f.ambiguousNodes.map((a, i) => (
                  <li key={`${f.fileKey}:node:${i}`} className="font-mono">
                    {a.kind === "node"
                      ? `${a.nodeName} (${a.nodeId}) — signs ${a.signIds.join(", ")}`
                      : `${a.nodeName} — signs ${a.signIds.join(", ")}`}
                  </li>
                )),
              )}
            </Section>
          )}

          <p className="text-[11px] text-[var(--zinc-500)]">
            Manifest for <strong>{bucketLabel}</strong> · generated{" "}
            {manifest.generatedAt.slice(0, 19).replace("T", " ")} UTC. Hand the
            JSON to the Figma pass to execute the appends / corrections, and
            clear the deletes / stale nodes.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "sky" | "fuchsia" | "emerald";
}) {
  const color =
    value === 0
      ? "text-[var(--zinc-500)]"
      : tone === "amber"
        ? "text-amber-300"
        : tone === "sky"
          ? "text-sky-300"
          : tone === "fuchsia"
            ? "text-fuchsia-300"
            : tone === "emerald"
              ? "text-emerald-300"
              : "text-[var(--foreground)]";
  return (
    <span className={color}>
      {value} {label}
    </span>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "amber" | "sky" | "fuchsia" | "emerald";
  children: React.ReactNode;
}) {
  const border =
    tone === "amber"
      ? "border-amber-900"
      : tone === "sky"
        ? "border-sky-900"
        : tone === "emerald"
          ? "border-emerald-900"
          : "border-fuchsia-900";
  return (
    <details className={`rounded border ${border} bg-[var(--surface)] px-3 py-2`}>
      <summary className="cursor-pointer select-none text-[11px] uppercase tracking-[0.06em] text-[var(--zinc-400)]">
        {title}
      </summary>
      <ul className="mt-2 space-y-0.5 pl-1">{children}</ul>
    </details>
  );
}
