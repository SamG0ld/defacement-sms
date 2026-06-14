import type { PrintSummary } from "@/lib/print-summary";

// The live "what to print" summary, auto-counted from the current sign list.
// Always rendered (even with zero signs); materials shown as proportional bars
// rather than a dense table.

export function PrintSummarySection({ summary }: { summary: PrintSummary }) {
  const max = Math.max(1, ...summary.materials.map((m) => m.total));

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-300">
          Print summary{" "}
          <span className="text-xs font-normal text-zinc-500">
            (auto-counted from {summary.totalSigns} sign
            {summary.totalSigns === 1 ? "" : "s"})
          </span>
        </h2>
        {summary.totalSigns > 0 && (
          <div className="flex gap-4 text-xs text-zinc-400">
            <span>
              Easels required:{" "}
              <strong className="text-zinc-200">{summary.easelsRequired}</strong>
            </span>
            <span>
              Meterboard stands:{" "}
              <strong className="text-zinc-200">
                {summary.meterboardStands}
              </strong>
            </span>
          </div>
        )}
      </div>

      {summary.totalSigns === 0 ? (
        <p className="text-sm text-zinc-500">
          No signs loaded yet — import signs to see what needs printing (and the
          derived easel / meterboard counts that drive the hardware needs below).
        </p>
      ) : (
        <div className="space-y-2">
          {summary.materials.map((m) => (
            <div key={m.key} className="flex items-center gap-3 text-sm">
              <div className="w-44 shrink-0 truncate text-zinc-300" title={m.label}>
                {m.label}
              </div>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-2 rounded-full bg-[var(--accent)]"
                  style={{ width: `${Math.round((m.total / max) * 100)}%` }}
                />
              </div>
              <div className="w-28 shrink-0 text-right font-mono tabular-nums text-zinc-200">
                {m.total}
                {m.double > 0 && (
                  <span className="text-xs text-zinc-500">
                    {" "}
                    ({m.single}s/{m.double}d)
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
