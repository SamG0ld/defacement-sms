import Link from "next/link";

import { deploymentSlotLabel, safeColor, shortZoneLabel } from "../_lib";
import { RowCheckbox, SelectAllHeader } from "../_selection";
import { RowStatusControl } from "../_status-control";
import { HardwareToggle } from "./HardwareToggle";
import type { SignRow } from "./types";

// Desktop signs table (hidden below md, where SignCards takes over). Each header
// carries a tooltip; rows delegate to the selection/status/hardware islands.
export function SignsTable({ signs }: { signs: SignRow[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 md:block">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="w-8 px-3 py-2" title="Select rows for a bulk action">
              <SelectAllHeader />
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Item ID — the sign's stable identifier; click it to open the detail page"
            >
              Item
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="The sign's display text. ×N shows the quantity when more than one"
            >
              Sign
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Sign type — e.g. Directional, Informational, Banner, Poster"
            >
              Type
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Placement zone (Level / Hall); off-site buildings keep their prefix"
            >
              Zone
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Deployment slot — con day + AM/PM for time-rotated signs"
            >
              Slot
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Tags — villages, tracks, and other groupings"
            >
              Tags
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Workflow stage — click a status, then Confirm, to change it"
            >
              Status
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Hardware — for easel / meterboard signs, whether the gear has been collected; click to toggle"
            >
              HW
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {signs.map((sign) => (
            <tr key={sign.id} className="align-top text-zinc-200">
              <td className="px-3 py-2">
                <RowCheckbox signId={sign.id} />
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                <Link
                  href={`/signs/${sign.id}`}
                  className="text-zinc-300 hover:text-white hover:underline"
                >
                  {sign.itemId}
                </Link>
              </td>
              <td className="px-3 py-2">
                <Link href={`/signs/${sign.id}`} className="hover:underline">
                  {sign.signText}
                </Link>
                {sign.quantity > 1 && (
                  <span className="ml-2 text-xs text-zinc-500">
                    ×{sign.quantity}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-400">{sign.signType}</td>
              <td className="px-3 py-2 text-zinc-400">
                {shortZoneLabel(sign.zone)}
              </td>
              <td className="px-3 py-2 text-zinc-400">
                {deploymentSlotLabel(sign.deploymentSlot)}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {sign.tagAssignments.map((a) => (
                    <span
                      key={a.tagId}
                      className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300"
                      style={{ borderColor: safeColor(a.tag.color) }}
                    >
                      {a.tag.name}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2">
                <RowStatusControl signId={sign.id} status={sign.status} />
              </td>
              <td className="px-3 py-2">
                <HardwareToggle sign={sign} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
