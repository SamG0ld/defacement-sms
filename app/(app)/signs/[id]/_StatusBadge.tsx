"use client";

// The detail-page header status badge, made queue-aware so it doesn't lag behind
// the StatusForm below it while a change is queued (offline, before router
// .refresh lands). Reads the durable queue's optimistic overlay on top of the
// server-rendered status; falls back to the plain server status with no provider.

import type { SignStatus } from "@/app/generated/prisma/client";

import { statusBadgeClass } from "../_lib";
import { useStatusSync } from "../_sync/provider";

export function DetailStatusBadge({
  signId,
  status,
}: {
  signId: number;
  status: SignStatus;
}) {
  const sync = useStatusSync();
  const entry = sync?.overlay[signId];
  const current = (entry?.status as SignStatus | undefined) ?? status;
  const indicator = entry?.indicator;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs uppercase ${statusBadgeClass(current)}`}
    >
      {current}
      {indicator === "queued" && (
        <span className="text-amber-300" title="Queued — syncing">
          ⟳
        </span>
      )}
      {indicator === "failed" && (
        <span className="text-danger" title="Sync failed — see the queue">
          !
        </span>
      )}
    </span>
  );
}
