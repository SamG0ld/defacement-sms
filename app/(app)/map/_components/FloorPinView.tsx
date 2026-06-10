import Link from "next/link";

import { ZoomCanvas } from "./ZoomCanvas";

export type FloorPin = {
  key: string | number;
  xPct: number;
  yPct: number;
  title?: string;
  href?: string;
  active?: boolean;
  // Tailwind bg class for the dot (e.g. a status color). Defaults to accent.
  toneClass?: string;
};

// Read-only floor map with pins overlaid by percentage (resolution-independent).
// Shared by the sign-detail "Where it goes" panel and the /map overview. Server
// component — no interactivity beyond optional per-pin links.
export function FloorPinView({
  src,
  label,
  pins,
}: {
  src: string;
  label: string;
  pins: FloorPin[];
}) {
  return (
    <ZoomCanvas>
      <div className="relative w-full bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element -- static bundled floorplan, intrinsic size unknown */}
        <img src={src} alt={label} className="block h-auto w-full select-none" />
        {pins.map((p) => {
          const dot = (
            <span
              className={`block rounded-full ring-2 ring-white ${
                p.toneClass ?? "bg-[var(--accent)]"
              } ${p.active ? "h-4 w-4" : "h-3 w-3"}`}
            />
          );
          return (
            <div
              key={p.key}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${p.xPct}%`, top: `${p.yPct}%` }}
              title={p.title}
            >
              {p.href ? (
                <Link href={p.href} aria-label={p.title}>
                  {dot}
                </Link>
              ) : (
                dot
              )}
            </div>
          );
        })}
      </div>
    </ZoomCanvas>
  );
}
