import { setHardwareCollected } from "../actions";
import { hardwareKind, needsHardware } from "../_lib";

// Per-row hardware-collected toggle. Renders only for signs that need hardware
// (easel / meterboard); a server-action form with one submit button (binary +
// reversible, so one-click is fine — no confirm step like the status control).
export function HardwareToggle({
  sign,
}: {
  sign: {
    id: number;
    needsEasel: boolean;
    size: string;
    equipmentCheckedOut: boolean;
  };
}) {
  if (!needsHardware(sign)) return null;
  const collected = sign.equipmentCheckedOut;
  const kind = hardwareKind(sign);
  return (
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
            ? "rounded border border-[var(--accent)] px-1.5 py-0.5 text-[10px] uppercase text-accent hover:opacity-80"
            : "rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        }
      >
        {collected ? "HW ✓" : "HW"}
      </button>
    </form>
  );
}
