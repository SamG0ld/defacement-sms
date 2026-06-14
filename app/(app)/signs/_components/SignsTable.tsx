import Link from "next/link";

import { deploymentSlotLabel, safeColor, shortZoneLabel } from "../_lib";
import { RowCheckbox, SelectAllHeader } from "../_selection";
import { RowStatusControl } from "../_status-control";
import { HardwareToggle } from "./HardwareToggle";
import type { SignRow } from "./types";

// Desktop signs table (SignsView mounts it on desktop; SignCards on mobile).
// Console treatment (.datatable): mono item IDs, accent hover rail. Rows keep the
// real selection / status / hardware islands. Each header carries a tooltip.
export function SignsTable({ signs }: { signs: SignRow[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="datatable">
          <thead>
            <tr>
              <th
                className="w-8"
                title="Select rows for a bulk action"
                style={{ paddingRight: 0 }}
              >
                <SelectAllHeader />
              </th>
              <th title="Item ID — the sign's stable identifier; click it to open the detail page">
                Item
              </th>
              <th title="The sign's display text. ×N shows the quantity when more than one">
                Sign
              </th>
              <th title="Sign type — e.g. Directional, Informational, Banner, Poster">
                Type
              </th>
              <th title="Placement zone (Level / Hall); off-site buildings keep their prefix">
                Zone
              </th>
              <th title="Deployment slot — con day + AM/PM for time-rotated signs">
                Slot
              </th>
              <th title="Tags — villages, tracks, and other groupings">Tags</th>
              <th title="Workflow stage — click a status, then Confirm, to change it">
                Status
              </th>
              <th title="Hardware — for easel / meterboard signs, whether the gear has been collected; click to toggle">
                HW
              </th>
            </tr>
          </thead>
          <tbody>
            {signs.map((sign) => (
              <tr key={sign.id}>
                <td style={{ paddingRight: 0 }}>
                  <RowCheckbox signId={sign.id} />
                </td>
                <td>
                  <Link href={`/signs/${sign.id}`} className="t-id hover:underline">
                    {sign.itemId}
                  </Link>
                </td>
                <td>
                  <Link href={`/signs/${sign.id}`} className="t-text hover:underline">
                    {sign.signText}
                  </Link>
                  {sign.quantity > 1 && (
                    <span className="t-mono" style={{ marginLeft: 8 }}>
                      ×{sign.quantity}
                    </span>
                  )}
                </td>
                <td className="t-dim">{sign.signType}</td>
                <td className="t-dim">{shortZoneLabel(sign.zone)}</td>
                <td className="t-mono">
                  {deploymentSlotLabel(sign.deploymentSlot)}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {sign.tagAssignments.length ? (
                      sign.tagAssignments.map((a) => (
                        // safeColor() strictly allowlists #RRGGBB — load-bearing,
                        // it's what keeps the tag color out of a CSS-injection sink.
                        <span
                          key={a.tagId}
                          className="tag"
                          style={
                            { "--tc": safeColor(a.tag.color) } as React.CSSProperties
                          }
                        >
                          {a.tag.name}
                        </span>
                      ))
                    ) : (
                      <span style={{ color: "var(--zinc-700)" }}>—</span>
                    )}
                  </div>
                </td>
                <td>
                  <RowStatusControl signId={sign.id} status={sign.status} />
                </td>
                <td>
                  <HardwareToggle sign={sign} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
