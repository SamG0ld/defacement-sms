"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  applyReconcile,
  previewReconcile,
  type ReconcileApplyResult,
  type ReconcilePreview,
} from "../actions";
import {
  FIELD_LABELS,
  MAX_LISTED_FAILED_IDS,
  type AddChange,
  type Ambiguous,
  type DeptChange,
  type FieldValue,
  type ReconcileField,
  type RemoveChange,
  type UpdateChange,
} from "@/lib/reconcile";

function renderVal(_field: ReconcileField, v: FieldValue): string {
  if (v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function deptLabel(tag: string | null): string {
  return tag ?? "—";
}

export function ReconcileWizard() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ReconcilePreview | null>(null);
  const [acceptedAdds, setAcceptedAdds] = useState<Set<string>>(new Set());
  const [acceptedChanges, setAcceptedChanges] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ReconcileApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const text = await file.text();
        setCsv(text);
        setFileName(file.name);
        const pv = await previewReconcile(text);
        setPreview(pv);
        // Default: accept every add + every signText change. All are reviewable and
        // reversible (a lead unchecks anything they don't want; nothing deletes).
        setAcceptedAdds(new Set(pv.result.adds.map((a) => a.identity)));
        setAcceptedChanges(new Set(pv.result.changes.map((c) => c.identity)));
      } catch {
        setError("Could not read the file. Make sure you're signed in as a lead.");
      }
    });
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function onApply() {
    startTransition(async () => {
      try {
        const res = await applyReconcile(csv, {
          adds: [...acceptedAdds],
          changes: [...acceptedChanges],
        });
        setResult(res);
        router.refresh();
      } catch {
        setError("Apply failed. Nothing was changed.");
      }
    });
  }

  const acceptCount = acceptedAdds.size + acceptedChanges.size;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <label className="btn-primary rounded px-3 py-1.5 text-sm font-medium cursor-pointer">
          Choose sheet CSV…
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="hidden"
          />
        </label>
        {fileName && <span className="text-sm text-zinc-400">{fileName}</span>}
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
            Applied: <strong>{result.added}</strong> added,{" "}
            <strong>{result.changed}</strong> text change
            {result.changed === 1 ? "" : "s"}.
            {result.failed > 0 && ` ${result.failed} failed.`}
          </p>
          {result.skippedAdds > 0 && (
            <p className="text-amber-200">
              {result.skippedAdds} accepted{" "}
              {result.skippedAdds === 1 ? "add" : "adds"} already existed and{" "}
              {result.skippedAdds === 1 ? "was" : "were"} skipped — no duplicate was
              created.
            </p>
          )}
          {result.failedIds.length > 0 && (
            <p className="text-amber-200">
              These text changes didn&apos;t land (the sign was removed mid-apply, or
              its batch failed) — re-run the reconcile to retry them:{" "}
              {result.failedIds
                .slice(0, MAX_LISTED_FAILED_IDS)
                .map((id) => `#${id}`)
                .join(", ")}
              {result.failedIds.length > MAX_LISTED_FAILED_IDS &&
                ` +${result.failedIds.length - MAX_LISTED_FAILED_IDS} more`}
              .
            </p>
          )}
          <Link href="/signs" className="underline hover:text-emerald-100">
            View signs →
          </Link>
        </div>
      )}

      {preview?.headerError && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">
          {preview.headerError}
        </div>
      )}

      {preview && !preview.headerError && !result && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Added" value={preview.result.counts.add} tone="text-emerald-300" />
            <Stat label="Text changes" value={preview.result.counts.change} tone="text-sky-300" />
            <Stat label="Removed" value={preview.result.counts.remove} tone="text-amber-300" />
            <Stat label="Dept changes" value={preview.result.counts.deptChange} tone="text-violet-300" />
            <Stat label="Ambiguous" value={preview.result.counts.ambiguous} tone="text-fuchsia-300" />
            <Stat label="Unchanged" value={preview.result.counts.unchanged} tone="text-zinc-400" />
            <Stat label="Invalid" value={preview.invalid} tone="text-red-300" />
          </div>

          {preview.notices.length > 0 && (
            <div className="rounded-md border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-200">
              {preview.notices.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          )}

          {preview.result.adds.length > 0 && (
            <Section title={`Added (${preview.result.adds.length})`} tone="emerald">
              <div className="space-y-2">
                {preview.result.adds.map((a) => (
                  <AddRow
                    key={a.identity}
                    add={a}
                    checked={acceptedAdds.has(a.identity)}
                    onToggle={() => setAcceptedAdds((s) => toggle(s, a.identity))}
                  />
                ))}
              </div>
            </Section>
          )}

          {preview.result.changes.length > 0 && (
            <Section title={`Text changes (${preview.result.changes.length})`} tone="sky">
              <p className="mb-2 text-xs text-sky-200/80">
                Only the printed sign text is updated. Size, notes, placement, and all
                deploy/QM state are left exactly as they are.
              </p>
              <div className="space-y-2">
                {preview.result.changes.map((c) => (
                  <ChangeRow
                    key={c.identity}
                    change={c}
                    checked={acceptedChanges.has(c.identity)}
                    onToggle={() =>
                      setAcceptedChanges((s) => toggle(s, c.identity))
                    }
                  />
                ))}
              </div>
            </Section>
          )}

          {preview.result.deptChanges.length > 0 && (
            <Section
              title={`Department changes — informational (${preview.result.deptChanges.length})`}
              tone="violet"
            >
              <p className="mb-2 text-xs text-violet-200/80">
                The sheet reclassified these spaces&apos; department. Nothing is
                applied — sizing is the team&apos;s call — but you may want to
                re-decide each sign&apos;s size.
              </p>
              <div className="space-y-1">
                {preview.result.deptChanges.map((d) => (
                  <DeptRow key={d.signId} dept={d} />
                ))}
              </div>
            </Section>
          )}

          {preview.result.removes.length > 0 && (
            <Section title={`Removed — flagged, not deleted (${preview.result.removes.length})`} tone="amber">
              <p className="mb-2 text-xs text-amber-200/80">
                These master-sheet signs aren&apos;t in the uploaded file. Nothing is
                deleted — verify whether they were intentionally removed and handle
                them by hand.
              </p>
              <div className="space-y-1">
                {preview.result.removes.map((r) => (
                  <RemoveRow key={r.signId} remove={r} />
                ))}
              </div>
            </Section>
          )}

          {preview.result.ambiguous.length > 0 && (
            <Section title={`Ambiguous (${preview.result.ambiguous.length})`} tone="fuchsia">
              <p className="mb-2 text-xs text-fuchsia-200/80">
                Each of these matches more than one sign, so reconcile won&apos;t
                touch them automatically. Resolve the duplicates by hand.
              </p>
              <div className="space-y-1">
                {preview.result.ambiguous.map((a) => (
                  <AmbiguousRow key={a.identity} amb={a} />
                ))}
              </div>
            </Section>
          )}

          <button
            type="button"
            onClick={onApply}
            disabled={pending || acceptCount === 0}
            className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {pending
              ? "Applying…"
              : `Apply ${acceptCount} change${acceptCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}

function AddRow({
  add,
  checked,
  onToggle,
}: {
  add: AddChange;
  checked: boolean;
  onToggle: () => void;
}) {
  const { sheet } = add;
  const overridden = sheet.signText !== sheet.sheetName;
  return (
    <label className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-zinc-400">{sheet.itemId}</span>
          <span className="text-zinc-100">{sheet.sheetName}</span>
          {sheet.isSock && <Badge tone="zinc">sock</Badge>}
          {sheet.deptTag && <Badge tone="zinc">{sheet.deptTag}</Badge>}
        </span>
        {overridden && (
          <span className="mt-0.5 block text-xs text-zinc-500">
            prints “{sheet.signText}”
          </span>
        )}
      </span>
    </label>
  );
}

function ChangeRow({
  change,
  checked,
  onToggle,
}: {
  change: UpdateChange;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-zinc-400">
            {change.sheet.itemId}
          </span>
          <span className="text-zinc-100">{change.sheet.sheetName}</span>
          {change.sheet.isSock && <Badge tone="zinc">sock</Badge>}
        </span>
        <span className="mt-1 flex flex-col gap-1">
          {change.fields.map((f) => (
            <span key={f.field} className="text-xs">
              <span className="text-zinc-500">{FIELD_LABELS[f.field]}: </span>
              <span className="text-zinc-400 line-through">
                {renderVal(f.field, f.from)}
              </span>
              <span className="text-zinc-600"> → </span>
              <span className="text-sky-300">{renderVal(f.field, f.to)}</span>
            </span>
          ))}
        </span>
      </span>
    </label>
  );
}

function DeptRow({ dept }: { dept: DeptChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
      <span className="font-mono text-xs text-zinc-500">{dept.itemId}</span>
      <span className="text-zinc-300">{dept.sheetName}</span>
      <span className="text-xs text-zinc-500">
        department{" "}
        <span className="text-zinc-400">{deptLabel(dept.from)}</span>
        <span className="text-zinc-600"> → </span>
        <span className="text-violet-300">{deptLabel(dept.to)}</span>
      </span>
    </div>
  );
}

function RemoveRow({ remove }: { remove: RemoveChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
      <span className="font-mono text-xs text-zinc-500">
        {remove.app.itemId}
      </span>
      <span className="text-zinc-300">{remove.app.sheetName}</span>
      {remove.app.isSock && <Badge tone="zinc">sock</Badge>}
      <span className="text-xs text-zinc-600">#{remove.signId}</span>
    </div>
  );
}

function AmbiguousRow({ amb }: { amb: Ambiguous }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
      <span className="text-zinc-300">{amb.sheetName}</span>
      <span className="text-xs text-zinc-500">
        matches {amb.signIds.length} signs ({amb.signIds.map((id) => `#${id}`).join(", ")})
      </span>
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "emerald" | "sky" | "amber" | "fuchsia" | "violet";
  children: React.ReactNode;
}) {
  const border = {
    emerald: "border-emerald-900",
    sky: "border-sky-900",
    amber: "border-amber-900",
    fuchsia: "border-fuchsia-900",
    violet: "border-violet-900",
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

function Badge({
  tone,
  children,
}: {
  tone: "zinc" | "amber";
  children: React.ReactNode;
}) {
  const cls = {
    zinc: "border-zinc-700 bg-zinc-900 text-zinc-400",
    amber: "border-amber-800 bg-amber-950 text-amber-300",
  }[tone];
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${cls}`}>
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}
