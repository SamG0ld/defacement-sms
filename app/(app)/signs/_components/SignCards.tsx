import Link from "next/link";

import { deploymentSlotLabel, safeColor, shortZoneLabel } from "../_lib";
import { RowCheckbox } from "../_selection";
import { RowStatusControl } from "../_status-control";
import { HardwareToggle } from "./HardwareToggle";
import type { SignRow } from "./types";

// Mobile card view of the signs list (md:hidden — SignsTable takes over above md).
export function SignCards({ signs }: { signs: SignRow[] }) {
  return (
    <div className="space-y-3 md:hidden">
      {signs.map((sign) => (
        <div
          key={sign.id}
          className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2">
              <span className="pt-0.5">
                <RowCheckbox signId={sign.id} />
              </span>
              <Link href={`/signs/${sign.id}`} className="min-w-0">
                <div className="truncate font-medium text-zinc-100">
                  {sign.signText}
                </div>
                <div className="font-mono text-xs text-zinc-500">
                  {sign.itemId} · {sign.signType}
                </div>
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
            <span>{sign.zone ? shortZoneLabel(sign.zone) : "no zone"}</span>
            <span>·</span>
            <span>{deploymentSlotLabel(sign.deploymentSlot)}</span>
          </div>
          {sign.tagAssignments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sign.tagAssignments.map((a) => (
                <span
                  key={a.tagId}
                  className="rounded border px-1.5 py-0.5 text-[10px] text-zinc-300"
                  style={{ borderColor: safeColor(a.tag.color) }}
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
