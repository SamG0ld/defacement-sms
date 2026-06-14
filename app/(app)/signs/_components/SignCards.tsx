import Link from "next/link";

import { deploymentSlotLabel, safeColor, shortZoneLabel } from "../_lib";
import { RowCheckbox } from "../_selection";
import { RowStatusControl } from "../_status-control";
import { HardwareToggle } from "./HardwareToggle";
import type { SignRow } from "./types";

// Mobile card view of the signs list (SignsView mounts it on mobile; SignsTable
// on desktop). Console treatment (.signcard): bold sign text, mono id/type line,
// dim meta row. Keeps the real selection / status / hardware islands.
export function SignCards({ signs }: { signs: SignRow[] }) {
  return (
    <div className="flex flex-col gap-[9px]">
      {signs.map((sign) => (
        <div key={sign.id} className="signcard">
          <div className="flex items-start gap-2">
            <span className="pt-0.5">
              <RowCheckbox signId={sign.id} />
            </span>
            <Link href={`/signs/${sign.id}`} className="min-w-0 flex-1">
              <div className="sc-text">
                {sign.signText}
                {sign.quantity > 1 && (
                  <span
                    className="ml-1.5 font-mono text-[12px] font-normal"
                    style={{ color: "var(--zinc-500)" }}
                  >
                    ×{sign.quantity}
                  </span>
                )}
              </div>
              <div className="sc-id mt-[3px]">
                {sign.itemId} · {sign.signType}
              </div>
            </Link>
          </div>

          <div className="sc-meta">
            <span>{sign.zone ? shortZoneLabel(sign.zone) : "no zone"}</span>
            <span style={{ color: "var(--zinc-700)" }}>·</span>
            <span className="mono">
              {deploymentSlotLabel(sign.deploymentSlot)}
            </span>
          </div>

          {sign.tagAssignments.length > 0 && (
            <div className="flex flex-wrap gap-[5px]">
              {sign.tagAssignments.map((a) => (
                // safeColor() strictly allowlists #RRGGBB — load-bearing, it's what
                // keeps the tag color out of a CSS-injection sink.
                <span
                  key={a.tagId}
                  className="tag"
                  style={{ "--tc": safeColor(a.tag.color) } as React.CSSProperties}
                >
                  {a.tag.name}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <RowStatusControl signId={sign.id} status={sign.status} />
            <HardwareToggle sign={sign} />
          </div>
        </div>
      ))}
    </div>
  );
}
