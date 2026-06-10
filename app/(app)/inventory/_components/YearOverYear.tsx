import { conLabelForYear } from "@/lib/con-config";

// Year-over-year end-of-con counts, headlined by con number (DC30, DC31 …) with
// the calendar year as a subtitle. Sign-material print totals live here only
// (they're derived live elsewhere, not manually inventoried).

export type HistoryRow = {
  equipmentTypeId: number;
  year: number;
  countEndOfCon: number;
  equipmentType: { name: string; category: string | null };
};

export function YearOverYear({ history }: { history: HistoryRow[] }) {
  if (history.length === 0) return null;

  const years = [...new Set(history.map((h) => h.year))].sort((a, b) => a - b);

  // Group by the stable type id (a rename across years still collapses to one
  // row); display the most recent name/category.
  const byType = new Map<
    number,
    { name: string; category: string | null; byYear: Map<number, number> }
  >();
  for (const h of history) {
    if (!byType.has(h.equipmentTypeId)) {
      byType.set(h.equipmentTypeId, {
        name: h.equipmentType.name,
        category: h.equipmentType.category,
        byYear: new Map(),
      });
    }
    byType.get(h.equipmentTypeId)!.byYear.set(h.year, h.countEndOfCon);
  }

  const rows = [...byType.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort(
      (a, b) =>
        (a.category ?? "").localeCompare(b.category ?? "") ||
        a.name.localeCompare(b.name),
    );

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-300">
        Year over year — end-of-con counts
      </h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Item</th>
              {years.map((y) => (
                <th key={y} className="px-3 py-2 text-right font-medium">
                  <div>{conLabelForYear(y)}</div>
                  <div className="text-[10px] font-normal normal-case text-zinc-600">
                    {y}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.id} className="text-zinc-200">
                <td className="px-3 py-2">
                  {row.name}
                  {row.category && (
                    <span className="ml-2 text-xs text-zinc-500">
                      {row.category}
                    </span>
                  )}
                </td>
                {years.map((y) => (
                  <td
                    key={y}
                    className="px-3 py-2 text-right tabular-nums text-zinc-300"
                  >
                    {row.byYear.has(y) ? row.byYear.get(y) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
