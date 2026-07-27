import type { QmGroupRow } from "@/lib/qm-stock";

import { QmStockRow } from "./QmStockRow";

// QM pile rollup: every group of identical signs (size > 1) with how many are out
// and how many remain at the quartermaster desk, plus a Take N / Return N control
// per pile. Take/return is also available on each sign's detail page.

export function QmStockSection({ rows }: { rows: QmGroupRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-300">
          QM stock — remaining at the desk
        </h2>
        <span className="text-xs text-zinc-500">
          {rows.length} pile{rows.length === 1 ? "" : "s"} · take / return here or
          on each sign&apos;s page
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-1 pr-3 font-medium">Sign</th>
              <th className="py-1 pr-3 font-medium">Size</th>
              <th className="py-1 pr-3 text-right font-medium">Total</th>
              <th className="py-1 pr-3 text-right font-medium">Out</th>
              <th className="py-1 pr-3 text-right font-medium">Remaining</th>
              <th className="py-1 text-right font-medium">Take / return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <QmStockRow key={r.repId} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
