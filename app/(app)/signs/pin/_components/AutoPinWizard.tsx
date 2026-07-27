"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  applyAutoPin,
  previewAutoPin,
  type AutoPinApplyResult,
  type AutoPinPreview,
  type EnabledMap,
} from "../actions";
import type { FloorMapRule } from "@/lib/auto-pin";

// A rule row in the editable table. `value` is only meaningful for prefix rules.
type RuleRow = { match: "prefix" | "numeric"; value: string; floorMapKey: string };

// Best-effort guess of which map a level belongs to, by matching the map's key or
// label. The admin confirms/edits before applying, so a wrong guess is harmless.
function guessMap(maps: EnabledMap[], needles: string[]): string {
  const hit = maps.find((m) => {
    const hay = `${m.key} ${m.label}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
  return hit?.key ?? "";
}

function defaultRules(maps: EnabledMap[]): RuleRow[] {
  return [
    { match: "prefix", value: "W2", floorMapKey: guessMap(maps, ["l2", "level 2"]) },
    { match: "prefix", value: "W3", floorMapKey: guessMap(maps, ["l3", "level 3"]) },
    { match: "prefix", value: "N2", floorMapKey: guessMap(maps, ["l2", "level 2"]) },
    { match: "numeric", value: "", floorMapKey: guessMap(maps, ["l1", "level 1"]) },
  ];
}

function toRules(rows: RuleRow[]): FloorMapRule[] {
  return rows
    .filter((r) => r.floorMapKey && (r.match === "numeric" || r.value.trim()))
    .map((r) =>
      r.match === "numeric"
        ? { match: "numeric", floorMapKey: r.floorMapKey }
        : { match: "prefix", value: r.value.trim(), floorMapKey: r.floorMapKey },
    );
}

export function AutoPinWizard({ maps }: { maps: EnabledMap[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<RuleRow[]>(() => defaultRules(maps));
  const [includeOverwrite, setIncludeOverwrite] = useState(false);
  const [preview, setPreview] = useState<AutoPinPreview | null>(null);
  const [result, setResult] = useState<AutoPinApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const labelByKey = useMemo(
    () => new Map(maps.map((m) => [m.key, m.label])),
    [maps],
  );

  function setRow(i: number, patch: Partial<RuleRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { match: "prefix", value: "", floorMapKey: "" }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  function onPreview() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        setPreview(await previewAutoPin(toRules(rows)));
      } catch {
        setError("Preview failed. Make sure you're signed in as an admin.");
      }
    });
  }

  function onApply() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await applyAutoPin(toRules(rows), { includeOverwrite });
        setResult(res);
        setPreview(null);
        router.refresh();
      } catch {
        setError("Apply failed. Nothing was changed.");
      }
    });
  }

  const plan = preview?.plan;
  const hasInvalid = (preview?.invalidRuleKeys.length ?? 0) > 0;
  const nothingToDo =
    !!plan &&
    plan.counts.link === 0 &&
    plan.counts.create === 0 &&
    plan.counts.overwrite === 0;

  return (
    <div className="space-y-6">
      {/* Prefix → map table */}
      <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">Prefix → floor map</h2>
        <p className="text-xs text-zinc-500">
          Each rule sends codes with a prefix (or all numeric booth codes) to a floor
          map. First matching rule wins.
        </p>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <select
                value={r.match}
                onChange={(e) =>
                  setRow(i, { match: e.target.value as RuleRow["match"] })
                }
                className="field w-36"
              >
                <option value="prefix">Prefix</option>
                <option value="numeric">Numeric (booths)</option>
              </select>
              <input
                type="text"
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                disabled={r.match === "numeric"}
                placeholder={r.match === "numeric" ? "starts with a digit" : "e.g. W2"}
                className="field w-32 disabled:opacity-40"
              />
              <span className="text-zinc-600">→</span>
              <select
                value={r.floorMapKey}
                onChange={(e) => setRow(i, { floorMapKey: e.target.value })}
                className="field w-64"
              >
                <option value="">— pick a floor map —</option>
                {maps.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="btn btn-sm"
                aria-label="Remove rule"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addRow} className="btn btn-sm">
          + Add rule
        </button>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onPreview}
          disabled={pending}
          className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {pending ? "Working…" : "Preview"}
        </button>
        {pending && <span className="text-xs text-zinc-500">working…</span>}
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border border-emerald-900 bg-emerald-950 p-4 text-sm text-emerald-200">
          <p>
            Linked <strong>{result.linked}</strong> sign(s) —{" "}
            <strong>{result.created}</strong> room(s) created,{" "}
            <strong>{result.rehomed}</strong> re-homed
            {result.skipped > 0 && `, ${result.skipped} skipped (no map)`}.
          </p>
          <p className="text-emerald-300/80">
            Now place each new / re-homed room once on the map — every sign in it pins
            automatically.
          </p>
          <Link href="/map" className="underline hover:text-emerald-100">
            Go to Map →
          </Link>
        </div>
      )}

      {hasInvalid && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">
          Some rules point at a floor map that no longer exists:{" "}
          {preview?.invalidRuleKeys.join(", ")}. Fix the table before applying.
        </div>
      )}

      {plan && !result && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Link" value={plan.counts.link} tone="text-emerald-300" />
            <Stat label="Create + link" value={plan.counts.create} tone="text-sky-300" />
            <Stat label="Range" value={plan.counts.range} tone="text-amber-300" />
            <Stat label="Unmatched" value={plan.counts.unmatched} tone="text-zinc-400" />
            <Stat label="Already placed" value={plan.counts.overwrite} tone="text-fuchsia-300" />
          </div>
          <p className="text-xs text-zinc-500">
            {plan.counts.distinctRoomsToPlace} distinct room(s) to place by hand
            {plan.counts.orphanRoomsToRehome > 0 &&
              ` · ${plan.counts.orphanRoomsToRehome} existing room(s) re-homed onto a map`}
            .
          </p>

          {plan.creates.length > 0 && (
            <Section title={`Create + link (${plan.creates.length} rooms)`} tone="sky">
              <GroupList
                rows={plan.creates.map((g) => ({
                  code: g.code,
                  count: g.signIds.length,
                  note: labelByKey.get(g.floorMapKey) ?? g.floorMapKey,
                }))}
              />
            </Section>
          )}

          {plan.links.length > 0 && (
            <Section title={`Link to existing room (${plan.links.length})`} tone="emerald">
              <GroupList
                rows={plan.links.map((g) => ({
                  code: g.code,
                  count: g.signIds.length,
                  note: g.roomOrphaned
                    ? g.floorMapKey
                      ? `re-home → ${labelByKey.get(g.floorMapKey) ?? g.floorMapKey}`
                      : "orphaned — no map rule"
                    : "already on a map",
                }))}
              />
            </Section>
          )}

          {plan.ranges.length > 0 && (
            <Section title={`Range / multi-room — place by hand (${plan.ranges.length})`} tone="amber">
              <GroupList rows={plan.ranges.map((g) => ({ code: g.code, count: g.signIds.length }))} />
            </Section>
          )}

          {plan.unmatched.length > 0 && (
            <Section title={`Unmatched — place by hand (${plan.unmatched.length})`} tone="zinc">
              <GroupList
                rows={plan.unmatched.map((g) => ({
                  code: g.code ?? "(blank)",
                  count: g.signIds.length,
                  note: g.reason === "blank" ? "no room code" : "no map rule",
                }))}
              />
            </Section>
          )}

          {plan.overwrite.length > 0 && (
            <Section title={`Already placed — skipped by default (${plan.overwrite.length})`} tone="fuchsia">
              <p className="mb-2 text-xs text-fuchsia-200/80">
                These signs already have a manual pin or room link. They&apos;re left
                alone unless you opt in below — overwriting replaces their placement.
              </p>
              <GroupList rows={plan.overwrite.map((g) => ({ code: g.code, count: g.signIds.length }))} />
              <label className="mt-3 flex items-center gap-2 text-sm text-fuchsia-200">
                <input
                  type="checkbox"
                  checked={includeOverwrite}
                  onChange={(e) => setIncludeOverwrite(e.target.checked)}
                  className="h-4 w-4"
                />
                Overwrite these {plan.counts.overwrite} already-placed sign(s) too
              </label>
            </Section>
          )}

          <button
            type="button"
            onClick={onApply}
            disabled={pending || hasInvalid || nothingToDo}
            className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {pending
              ? "Applying…"
              : nothingToDo
                ? "Nothing to apply"
                : `Apply — link ${plan.counts.link + plan.counts.create}${
                    includeOverwrite ? ` (+${plan.counts.overwrite} overwrite)` : ""
                  } sign(s)`}
          </button>
        </div>
      )}
    </div>
  );
}

function GroupList({
  rows,
}: {
  rows: { code: string; count: number; note?: string }[];
}) {
  const shown = rows.slice(0, 100);
  return (
    <div className="space-y-1">
      {shown.map((r, i) => (
        <div
          key={`${r.code}-${i}`}
          className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm"
        >
          <span className="font-mono text-xs text-zinc-200">{r.code}</span>
          <span className="text-xs text-zinc-500">
            {r.count} sign{r.count === 1 ? "" : "s"}
          </span>
          {r.note && <span className="ml-auto text-xs text-zinc-500">{r.note}</span>}
        </div>
      ))}
      {rows.length > shown.length && (
        <p className="px-1 text-xs text-zinc-600">+{rows.length - shown.length} more…</p>
      )}
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "emerald" | "sky" | "amber" | "fuchsia" | "zinc";
  children: React.ReactNode;
}) {
  const border = {
    emerald: "border-emerald-900",
    sky: "border-sky-900",
    amber: "border-amber-900",
    fuchsia: "border-fuchsia-900",
    zinc: "border-zinc-800",
  }[tone];
  return (
    <section className={`rounded-lg border ${border} bg-black/20 p-4`}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-300">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}
