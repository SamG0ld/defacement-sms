"use client";

// A collapsed pile (a group of identical signs, size > 1) in the desktop table —
// one clickable header row that expands to its member rows. The members are passed
// as server-rendered children, so they (and their selection / status islands) only
// hydrate once expanded. The header mirrors SignRowTr's 9 aligned columns: the
// expand chevron, the ×N count (item col), the representative row's
// name/type/zone/slot/tags, the live "N at QM" readout (status col), and the Take N
// / Return N control (hardware col; the action acts on the group via the
// representative id). Each group is its own <tbody> (valid HTML, keeps the group a
// unit).

import { useState } from "react";

import { deploymentSlotLabel, safeColor, shortZoneLabel } from "../_lib";
import { QmTakeReturn } from "./QmTakeReturn";
import type { SignRow } from "./types";

export function CollapsibleTableGroup({
  rep,
  total,
  taken: initialTaken,
  children,
}: {
  // The representative member (rows[0]) — the identity key guarantees its
  // type/zone/slot are identical across the pile; tags are shown from it too
  // (tags aren't in the key, so any divergence only surfaces once expanded).
  rep: SignRow;
  total: number;
  taken: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [taken, setTaken] = useState(initialTaken);
  const remaining = total - taken;
  const toggle = () => setOpen((o) => !o);

  return (
    <tbody>
      <tr
        className="group-header cursor-pointer border-t border-[var(--line)] bg-[var(--surface)]"
        onClick={toggle}
      >
        {/* 1. checkbox col — expand chevron (a11y button carries the keyboard /
            screen-reader control; the whole row is clickable for the mouse). */}
        <td style={{ paddingRight: 0 }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-expanded={open}
            aria-label={`Expand ${rep.signText} (${total} signs)`}
            className="flex items-center"
          >
            <span
              className="inline-block w-3 text-zinc-500 transition-transform"
              style={{ transform: open ? "rotate(90deg)" : "none" }}
            >
              ▸
            </span>
          </button>
        </td>
        {/* 2. ITEM — the pile count */}
        <td className="t-mono">×{total}</td>
        {/* 3. SIGN — the group name */}
        <td className="t-text">{rep.signText}</td>
        {/* 4. TYPE */}
        <td className="t-dim">{rep.signType}</td>
        {/* 5. ZONE */}
        <td className="t-dim">{shortZoneLabel(rep.zone)}</td>
        {/* 6. SLOT */}
        <td className="t-mono">{deploymentSlotLabel(rep.deploymentSlot)}</td>
        {/* 7. TAGS — representative row's chips (same markup + safeColor as SignRowTr) */}
        <td>
          <div className="flex flex-wrap gap-1">
            {rep.tagAssignments.length ? (
              rep.tagAssignments.map((a) => (
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
        {/* 8. STATUS — group-level "N at QM" readout (members can hold mixed
            statuses, so no single pill fits). */}
        <td className="text-xs text-zinc-500">{remaining} at QM</td>
        {/* 9. HW — Take / Return control. stopPropagation so operating it never
            toggles the group open/closed. */}
        <td onClick={(e) => e.stopPropagation()}>
          <QmTakeReturn
            repId={rep.id}
            total={total}
            taken={taken}
            onTaken={setTaken}
            label={`How many ${rep.signText} to take or return`}
          />
        </td>
      </tr>
      {open && children}
    </tbody>
  );
}
