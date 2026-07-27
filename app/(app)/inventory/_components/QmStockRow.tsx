"use client";

// One QM pile (a group of identical signs) in the inventory rollup: Total / Out /
// Remaining plus a Take N / Return N control. Owns the taken count so Out / Remaining
// update optimistically when the shared control reports the authoritative value.

import Link from "next/link";
import { useState } from "react";

import { QmTakeReturn } from "@/app/(app)/signs/_components/QmTakeReturn";
import type { QmGroupRow } from "@/lib/qm-stock";

export function QmStockRow({ row }: { row: QmGroupRow }) {
  const [taken, setTaken] = useState(row.taken);
  const remaining = row.total - taken;

  return (
    <tr className="border-t border-zinc-800/70 align-middle">
      <td className="py-1.5 pr-3">
        <Link
          href={`/signs/${row.repId}`}
          className="text-zinc-200 hover:text-accent"
        >
          {row.signText}
        </Link>
        <span className="ml-2 font-mono text-xs text-zinc-600">
          ×{row.total}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-zinc-400">{row.size}</td>
      <td className="py-1.5 pr-3 text-right text-zinc-400">{row.total}</td>
      <td className="py-1.5 pr-3 text-right text-zinc-400">{taken}</td>
      <td
        className={`py-1.5 pr-3 text-right font-semibold ${
          remaining === 0 ? "text-danger" : "text-zinc-100"
        }`}
      >
        {remaining}
      </td>
      <td className="py-1.5">
        <QmTakeReturn
          repId={row.repId}
          total={row.total}
          taken={taken}
          onTaken={setTaken}
          label={`How many ${row.signText} to take or return`}
        />
      </td>
    </tr>
  );
}
