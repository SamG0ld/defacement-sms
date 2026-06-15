// The animated DC34 spray-can circuit emblem — the login door's hero. A SERVER
// component on purpose: the 120-path trace data is static and presentational, so
// rendering here keeps it as inlined HTML in the RSC payload instead of shipping
// the ~44KB JSON into the client bundle (the login route is the first thing every
// unauthenticated visitor hits — possibly on no signal). All motion is CSS
// (.login-emblem* in globals.css), so the global reduced-motion guard freezes it.
//
// Three stacked layers: a breathing aura glow → the base raster → an SVG overlay
// whose strokes are the circuit centerlines, each running a short bright dash
// (stroke-dashoffset) so light travels along every individual wire. The traces are
// generated offline (skeletonize → SVG centerlines) from the source artwork and the
// raster is a pre-optimized WebP; both are committed (traces JSON here, image under
// public/), so no build-time art tooling ships with the app.

import traceData from "./login-patch-traces.json";

export function LoginEmblem() {
  return (
    <div className="login-emblem">
      <div aria-hidden className="login-emblem__aura" />
      {/* Plain <img>: this app doesn't use next/image anywhere (no images block in
          next.config); same plain-img + eslint-disable pattern as the rest of the door. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="login-emblem__base"
        src="/login-patch.webp"
        alt="DEF CON Defacement DC34 emblem"
        width={600}
        height={601}
      />
      <svg
        aria-hidden
        className="login-emblem__beams"
        viewBox={traceData.viewBox}
        fill="none"
      >
        {traceData.traces.map((t, i) => (
          // Per-trace stagger via the generator's distance-from-centre delay so
          // beams flow outward; the beam COLOR is uniform (set in CSS), so the
          // JSON's per-trace `color` is intentionally ignored.
          <path
            key={i}
            className="login-emblem__beam"
            d={t.d}
            pathLength={100}
            style={{ animationDelay: `${t.delay}s` }}
          />
        ))}
      </svg>
    </div>
  );
}
