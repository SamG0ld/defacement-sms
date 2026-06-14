import { SIGN_STATUSES } from "../_lib";

// Segmented workflow-distribution bar: one slice per status stage, width ∝ that
// stage's share of the total, colored by the per-year --status-* token. Purely
// decorative (the chips carry the same counts as text), so aria-hidden.
export function DistBar({
  counts,
  total,
}: {
  counts: Record<string, number>;
  total: number;
}) {
  return (
    <div className="distbar" title="Workflow distribution" aria-hidden="true">
      {SIGN_STATUSES.map((s) => {
        const w = total ? ((counts[s] ?? 0) / total) * 100 : 0;
        if (!w) return null;
        return (
          <span
            key={s}
            style={{ width: `${w}%`, background: `var(--status-${s})` }}
          />
        );
      })}
    </div>
  );
}
