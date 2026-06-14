import { TelemetryGauge } from "@/app/_components/TelemetryGauge";

export type ZoneProgress = {
  code: string;
  label: string;
  deployed: number;
  total: number;
};

// Desktop-only, read-only deployment-progress overview for /deploy: an overall
// telemetry gauge + Remaining / Zones-live stat cards, then a per-zone progress
// list. Pure server component — fed real counts from the page's groupBy. The
// actual claim/deploy actions live in the offline field flow below (DeployApp);
// this is a glanceable ops readout, not an interactive control (so no "arm"
// button). Renders nothing when there are no zones with signs. Motion: none here;
// the gauge's edge-tick pulse is frozen by the global reduced-motion guard.
export function ZoneDeployOverview({
  deployed,
  total,
  zones,
}: {
  deployed: number;
  total: number;
  zones: ZoneProgress[];
}) {
  if (zones.length === 0) return null;

  const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;
  const zonesLive = zones.filter(
    (z) => z.total > 0 && z.deployed >= z.total,
  ).length;

  return (
    <div className="space-y-4">
      {/* Telemetry console */}
      <div className="panel" style={{ padding: "15px 18px" }}>
        <TelemetryGauge
          deployed={deployed}
          total={total}
          pct={pct}
          segments={40}
        />
        <div className="mt-4 flex flex-wrap gap-2.5">
          <div className="panel-2 min-w-[120px] flex-1" style={{ padding: "10px 12px" }}>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--zinc-500)]">
              Remaining
            </div>
            <div
              className="mt-0.5 font-mono text-[22px] font-bold"
              style={{ color: "var(--highlight)" }}
            >
              {Math.max(0, total - deployed)}
            </div>
          </div>
          <div className="panel-2 min-w-[120px] flex-1" style={{ padding: "10px 12px" }}>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--zinc-500)]">
              Zones live
            </div>
            <div
              className="mt-0.5 font-mono text-[22px] font-bold"
              style={{ color: "var(--accent)" }}
            >
              {zonesLive}/{zones.length}
            </div>
          </div>
        </div>
      </div>

      {/* Per-zone progress */}
      <div className="panel" style={{ padding: "8px 18px 14px" }}>
        <div className="pb-1 pt-3">
          <span className="prompt">ZONES</span>
        </div>
        {zones.map((z) => (
          <ZoneRow key={z.code} zone={z} />
        ))}
      </div>
    </div>
  );
}

function ZoneRow({ zone }: { zone: ZoneProgress }) {
  const pct = zone.total > 0 ? Math.round((zone.deployed / zone.total) * 100) : 0;
  const complete = zone.total > 0 && zone.deployed >= zone.total;
  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--line)] py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="text-sm font-bold">{zone.label}</span>
        <span
          className="font-mono text-xs"
          style={{ color: complete ? "var(--accent)" : "var(--zinc-400)" }}
        >
          <b style={{ color: "var(--foreground)" }}>{zone.deployed}</b>/{zone.total}{" "}
          · {pct}%
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}
        role="img"
        aria-label={`${zone.label}: ${zone.deployed} of ${zone.total} deployed`}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: complete ? "var(--accent)" : "var(--brand)",
            boxShadow: complete ? "0 0 8px -1px var(--accent)" : "none",
          }}
        />
      </div>
    </div>
  );
}
