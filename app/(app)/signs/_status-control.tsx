"use client";

// Per-row status control on the /signs list: a deliberate two-step change so a
// stray click can't re-stage a sign. Click a status to ARM it (it highlights and
// a Confirm button appears); click Confirm to submit. Clicking the armed status
// again — or arming a different one — cancels/re-arms. The current status renders
// as a non-interactive badge. Submit goes through the same updateSignStatus
// Server Action as everywhere else (records history + keeps stamps consistent).

import { useState } from "react";

import type { SignStatus } from "@/app/generated/prisma/client";

import { updateSignStatus } from "./actions";
import { SIGN_STATUSES, statusBadgeClass } from "./_lib";

export function RowStatusControl({
  signId,
  status,
}: {
  signId: number;
  status: SignStatus;
}) {
  const [armed, setArmed] = useState<SignStatus | null>(null);

  return (
    <form
      action={updateSignStatus.bind(null, signId)}
      className="flex flex-wrap items-center gap-1"
    >
      {SIGN_STATUSES.map((s) => {
        if (s === status) {
          return (
            <span
              key={s}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s)}`}
            >
              {s}
            </span>
          );
        }
        const isArmed = armed === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => setArmed(isArmed ? null : s)}
            title={`Change status to ${s}`}
            className={
              isArmed
                ? `rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s)} ring-1 ring-[var(--accent)]`
                : "rounded border border-zinc-800 px-2 py-0.5 text-[10px] uppercase text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
            }
          >
            {s}
          </button>
        );
      })}

      {armed && (
        <>
          <input type="hidden" name="status" value={armed} />
          <button
            type="submit"
            className="rounded border border-[var(--accent)] px-2 py-0.5 text-[10px] uppercase text-accent hover:opacity-80"
          >
            ✓ confirm
          </button>
        </>
      )}
    </form>
  );
}
