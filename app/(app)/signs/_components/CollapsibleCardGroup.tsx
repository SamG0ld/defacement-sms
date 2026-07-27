"use client";

// A collapsed pile (a group of identical signs, size > 1) in the mobile card list —
// one tappable header card that expands to its member cards. Members are passed as
// server-rendered children, so they only hydrate once expanded. The header carries
// the live "N at QM" readout and a Take N / Return N control.

import { useState } from "react";

import { QmTakeReturn } from "./QmTakeReturn";

export function CollapsibleCardGroup({
  signText,
  repId,
  total,
  taken: initialTaken,
  children,
}: {
  signText: string;
  repId: number;
  total: number;
  taken: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [taken, setTaken] = useState(initialTaken);
  const remaining = total - taken;

  return (
    <div className="flex flex-col gap-[9px]">
      <div className="signcard">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left"
        >
          <span
            className="inline-block w-3 text-zinc-500 transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            ▸
          </span>
          <span className="sc-text min-w-0 flex-1 truncate">{signText}</span>
          <span className="font-mono text-[12px] text-zinc-500">×{total}</span>
        </button>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-500">{remaining} at QM</span>
          <QmTakeReturn
            repId={repId}
            total={total}
            taken={taken}
            onTaken={setTaken}
            label={`How many ${signText} to take or return`}
          />
        </div>
      </div>
      {open && children}
    </div>
  );
}
