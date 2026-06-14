// Console telemetry readout: a prompt label, a NNN/NNN · P% machine readout, and
// a segmented bar gauge. Pure presentational server component — pass it the
// numbers. Reused by signs (deploy progress), the deploy console, and later the
// dashboard. The gauge bar is decorative (aria-hidden); the textual readout
// carries the actual numbers for assistive tech. Motion (the edge-tick pulse)
// is frozen by the global reduced-motion guard.

type TelemetryGaugeProps = {
  deployed: number;
  total: number;
  pct: number;
  segments?: number;
  label?: string;
};

export function TelemetryGauge({
  deployed,
  total,
  pct,
  segments = 32,
  label = "DEPLOY",
}: TelemetryGaugeProps) {
  const filled = Math.round((pct / 100) * segments);
  const pad = (n: number) => String(n).padStart(3, "0");

  return (
    <div className="telemetry">
      <div className="thead">
        <span className="prompt">{label}</span>
        <span className="tread">
          <b>{pad(deployed)}</b>
          <span>
            {" "}
            / {pad(total)} · {pct}%
          </span>
        </span>
      </div>
      <div className="gauge" aria-hidden="true">
        {Array.from({ length: segments }, (_, i) => {
          const cls = i < filled ? "tick on" : i === filled ? "tick edge" : "tick";
          return <span key={i} className={cls} />;
        })}
      </div>
    </div>
  );
}
