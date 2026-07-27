import Link from "next/link";

import {
  deploymentSlotLabel,
  safeColor,
  shortZoneLabel,
  signTypeLabel,
} from "../_lib";
import { RowCheckbox } from "../_selection";
import { RowStatusControl } from "../_status-control";
import { HardwareToggle } from "./HardwareToggle";
import type { SignRow } from "./types";

// One signs-table row. Extracted so a singleton group renders it directly and a
// collapsed group expands to a stack of them. `nested` adds a subtle inset so an
// expanded group's members read as belonging to the header above. Keeps the real
// selection / status / hardware islands.
export function SignRowTr({
  sign,
  nested = false,
}: {
  sign: SignRow;
  nested?: boolean;
}) {
  return (
    <tr className={nested ? "bg-[var(--surface)]/40" : undefined}>
      <td style={{ paddingRight: 0 }}>
        <RowCheckbox signId={sign.id} />
      </td>
      <td>
        <Link
          href={`/signs/${sign.id}`}
          className="t-id hover:underline"
          style={nested ? { paddingLeft: 14 } : undefined}
        >
          {sign.itemId}
        </Link>
      </td>
      <td>
        <Link href={`/signs/${sign.id}`} className="t-text hover:underline">
          {sign.signText}
        </Link>
      </td>
      <td className="t-dim">{signTypeLabel(sign)}</td>
      <td className="t-dim">{shortZoneLabel(sign.zone)}</td>
      <td className="t-mono">{deploymentSlotLabel(sign.deploymentSlot)}</td>
      <td>
        <div className="flex flex-wrap gap-1">
          {sign.tagAssignments.length ? (
            sign.tagAssignments.map((a) => (
              // safeColor() strictly allowlists #RRGGBB — load-bearing, it's what
              // keeps the tag color out of a CSS-injection sink.
              <span
                key={a.tagId}
                className="tag"
                style={{ "--tc": safeColor(a.tag.color) } as React.CSSProperties}
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
  );
}
