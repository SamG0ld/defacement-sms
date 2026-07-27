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

// One signs card (mobile). Extracted so a singleton group renders it directly and a
// collapsed group expands to a stack of them. `nested` insets it under its group
// header. Keeps the real selection / status / hardware islands.
export function SignCardItem({
  sign,
  nested = false,
}: {
  sign: SignRow;
  nested?: boolean;
}) {
  return (
    <div className={`signcard${nested ? " ml-3 border-l border-[var(--line)]" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="pt-0.5">
          <RowCheckbox signId={sign.id} />
        </span>
        <Link href={`/signs/${sign.id}`} className="min-w-0 flex-1">
          <div className="sc-text">{sign.signText}</div>
          <div className="sc-id mt-[3px]">
            {sign.itemId} · {signTypeLabel(sign)}
          </div>
        </Link>
      </div>

      <div className="sc-meta">
        <span>{sign.zone ? shortZoneLabel(sign.zone) : "no zone"}</span>
        <span style={{ color: "var(--zinc-700)" }}>·</span>
        <span className="mono">{deploymentSlotLabel(sign.deploymentSlot)}</span>
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
  );
}
