import { setHardwareCollected, setHardwareReturned } from "../actions";
import { hardwareKind, needsHardware } from "../_lib";
import { Icons } from "@/app/_components/Icons";
import type { SignCategory } from "@/app/generated/prisma/enums";

// Per-row hardware indicator, covering the full lifecycle: NEED → collected →
// RETURNED. Signs that need hardware (easel / meterboard) get an interactive
// collected-toggle (a server-action form — binary + reversible, so one-click
// is fine, no confirm step like the status control); signs that need none
// render a muted "—" so the column reads consistently. The return step is a
// second, adjacent toggle that only appears once the hardware has actually
// been checked out — you can't return gear that was never collected.
export function HardwareToggle({
  sign,
}: {
  sign: {
    id: number;
    needsEasel: boolean;
    category: SignCategory;
    equipmentCheckedOut: boolean;
    equipmentReturned: boolean;
  };
}) {
  if (!needsHardware(sign)) {
    return (
      <span
        title="No hardware needed"
        aria-label="No hardware needed"
        className="text-[10px] uppercase tracking-wide text-zinc-600"
      >
        —
      </span>
    );
  }
  const collected = sign.equipmentCheckedOut;
  const returned = sign.equipmentReturned;
  const kind = hardwareKind(sign);
  return (
    <span className="inline-flex items-center gap-1">
      <form action={setHardwareCollected.bind(null, sign.id)} className="inline">
        <input type="hidden" name="collected" value={collected ? "0" : "1"} />
        <button
          type="submit"
          title={
            collected
              ? `${kind} collected — click to unmark`
              : `Needs ${kind} — click to mark collected`
          }
          className={
            collected
              ? "inline-flex items-center gap-1 rounded border border-[var(--accent)] px-1.5 py-0.5 text-[10px] uppercase text-accent hover:opacity-80"
              : "inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          }
        >
          <Icons.easel width={12} height={12} />
          {collected ? "GEAR" : "NEED"}
        </button>
      </form>
      {collected && (
        <form action={setHardwareReturned.bind(null, sign.id)} className="inline">
          <input type="hidden" name="returned" value={returned ? "0" : "1"} />
          <button
            type="submit"
            title={
              returned
                ? `${kind} returned — click to unmark`
                : `${kind} collected — click to mark returned`
            }
            className={
              returned
                ? "inline-flex items-center gap-1 rounded border border-[var(--accent)] px-1.5 py-0.5 text-[10px] uppercase text-accent hover:opacity-80"
                : "inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }
          >
            {returned ? "BACK" : "OUT"}
          </button>
        </form>
      )}
    </span>
  );
}
