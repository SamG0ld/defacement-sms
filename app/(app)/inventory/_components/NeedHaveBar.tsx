// A horizontal need-vs-have gauge. Fill = how much of the need is covered by
// what's on hand; green when covered, brand-blue while short. Renders nothing
// useful when there's no derived need (Stands/Banners) — caller shows just the
// have count instead.

export function NeedHaveBar({
  have,
  need,
}: {
  have: number;
  need: number | null;
}) {
  if (need === null || need <= 0) return null;
  const pct = Math.min(100, Math.round((have / need) * 100));
  const covered = have >= need;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-zinc-800"
      role="img"
      aria-label={`${have} of ${need} on hand`}
    >
      <div
        className={`h-2 rounded-full ${covered ? "bg-emerald-500" : "bg-[var(--brand)]"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
