"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  executeImport,
  previewImport,
  type ImportResult,
  type ImportSource,
} from "../actions";
import type { ImportPreview, MappedRow } from "../_map";

const PREVIEW_LIMIT = 50;

const SOURCES: { value: ImportSource; label: string }[] = [
  { value: "signSheet", label: "DC33 sign sheet (deploy matrix, sections)" },
  { value: "master", label: "Master inventory (one sign per space)" },
  { value: "generic", label: "Generic CSV (column headers)" },
];

function rowBadge(status: MappedRow["status"]): string {
  switch (status) {
    case "valid":
      return "border-emerald-800 bg-emerald-950 text-emerald-300";
    case "duplicate":
      return "border-yellow-800 bg-yellow-950 text-yellow-300";
    default:
      return "border-red-900 bg-red-950 text-red-300";
  }
}

export function ImportWizard() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState<ImportSource>("signSheet");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [asTestData, setAsTestData] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function loadPreview(text: string, src: ImportSource) {
    startTransition(async () => {
      try {
        setPreview(await previewImport(text, src));
      } catch {
        setError("Could not read the file. Make sure you're signed in as a lead.");
      }
    });
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setPreview(null);
    setIncludeDuplicates(false);
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    loadPreview(text, source);
  }

  function onSourceChange(src: ImportSource) {
    setSource(src);
    setResult(null);
    setPreview(null);
    if (csv) loadPreview(csv, src); // re-parse the loaded file under the new layout
  }

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await executeImport(csv, includeDuplicates, asTestData, source);
        setResult(res);
        router.refresh();
      } catch {
        setError("Import failed. Nothing was changed.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          What are you importing?
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value as ImportSource)}
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="btn-primary mt-4 rounded px-3 py-1.5 text-sm font-medium cursor-pointer">
          Choose CSV…
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
            Imported <strong>{result.imported}</strong> sign
            {result.imported === 1 ? "" : "s"}.
            {result.skipped > 0 && ` Skipped ${result.skipped}.`}
            {result.failed > 0 && ` ${result.failed} failed.`}
          </p>
          <Link href="/signs" className="underline hover:text-emerald-100">
            View signs →
          </Link>
        </div>
      )}

      {preview && !result && (
        <PreviewPanel
          preview={preview}
          includeDuplicates={includeDuplicates}
          setIncludeDuplicates={setIncludeDuplicates}
          asTestData={asTestData}
          setAsTestData={setAsTestData}
          onConfirm={onConfirm}
          pending={pending}
        />
      )}
    </div>
  );
}

function PreviewPanel({
  preview,
  includeDuplicates,
  setIncludeDuplicates,
  asTestData,
  setAsTestData,
  onConfirm,
  pending,
}: {
  preview: ImportPreview;
  includeDuplicates: boolean;
  setIncludeDuplicates: (v: boolean) => void;
  asTestData: boolean;
  setAsTestData: (v: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  if (preview.headerError) {
    return (
      <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">
        {preview.headerError}
      </div>
    );
  }

  const { counts } = preview;
  const willImport = counts.valid + (includeDuplicates ? counts.duplicate : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-sm">
        <Stat label="Valid" value={counts.valid} tone="text-emerald-300" />
        <Stat label="Duplicates" value={counts.duplicate} tone="text-yellow-300" />
        <Stat label="Invalid" value={counts.invalid} tone="text-red-300" />
        <Stat label="Total rows" value={counts.total} tone="text-zinc-300" />
      </div>

      <div className="text-xs text-zinc-500">
        Mapped columns: {preview.mappedColumns.join(", ") || "none"}.
        {preview.ignoredHeaders.length > 0 &&
          ` Ignored: ${preview.ignoredHeaders.join(", ")}.`}
      </div>

      {preview.notices && preview.notices.length > 0 && (
        <div className="rounded-md border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-200">
          {preview.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}

      {counts.duplicate > 0 && (
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={includeDuplicates}
            onChange={(e) => setIncludeDuplicates(e.target.checked)}
            className="h-4 w-4"
          />
          Also import the {counts.duplicate} likely-duplicate row
          {counts.duplicate === 1 ? "" : "s"}
        </label>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Sign text</th>
              <th className="px-3 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {preview.rows.slice(0, PREVIEW_LIMIT).map((r) => (
              <tr key={r.line} className="align-top text-zinc-200">
                <td className="px-3 py-2 text-xs text-zinc-500">{r.line}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] uppercase ${rowBadge(r.status)}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.data.itemId}</td>
                <td className="px-3 py-2">{r.data.signText}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">
                  {r.reason && <div className="text-red-300">{r.reason}</div>}
                  {r.warnings.map((w, i) => (
                    <div key={i} className="text-yellow-400">
                      {w}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.rows.length > PREVIEW_LIMIT && (
        <p className="text-xs text-zinc-500">
          Showing first {PREVIEW_LIMIT} of {preview.rows.length} rows.
        </p>
      )}

      <label className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={asTestData}
          onChange={(e) => setAsTestData(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          Import as test data
          <span className="mt-0.5 block text-xs text-zinc-500">
            Leave checked while testing — these signs can be wiped by “Clear test
            data”. Uncheck when importing the final list so it can’t be cleared.
          </span>
        </span>
      </label>

      <button
        type="button"
        onClick={onConfirm}
        disabled={pending || willImport === 0}
        className="btn-primary rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
      >
        {pending
          ? "Importing…"
          : `Import ${willImport} sign${willImport === 1 ? "" : "s"}`}
      </button>
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
  tone: string;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
    </div>
  );
}
