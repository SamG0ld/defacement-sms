import Link from "next/link";

import { DeployPhotoPin } from "../../signs/_components/DeployPhoto";
import { FloorImage } from "./FloorImage";
import { MapPin } from "./MapPin";
import { ZoomCanvas } from "./ZoomCanvas";

export type FloorPin = {
  key: string | number;
  xPct: number;
  yPct: number;
  title?: string;
  href?: string;
  active?: boolean;
  // Tailwind TEXT color class for the marker (filled via currentColor), e.g. a
  // status tone. Defaults to the accent.
  toneClass?: string;
  // When set, render a tappable pin that opens this sign's deploy photo instead
  // of a static dot/link. Mutually exclusive with href in practice.
  photoSignId?: number;
};

// Read-only floor map with pins overlaid by percentage (resolution-independent).
// Shared by the sign-detail "Where it goes" panel and the /map overview. Server
// component; pins are teardrop MapPin markers (tip-anchored, zoom-true), optional
// links, or — when photoSignId is set — a DeployPhotoPin client island that opens
// the sign's deploy photo. The floor image is a FloorImage client island
// (skeleton-on-load); both layers sit in the shared relative box.
export function FloorPinView({
  src,
  label,
  pins,
  imageWidth,
}: {
  src: string;
  label: string;
  pins: FloorPin[];
  // The floor image's native width — lets ZoomCanvas allow zooming to native
  // pixels so a dense map reads at its detail. Omitted → ZoomCanvas default.
  imageWidth?: number | null;
}) {
  return (
    <ZoomCanvas imageWidth={imageWidth}>
      <div className="relative w-full bg-white">
        <FloorImage src={src} label={label} />
        {/* Pins overlay the image in the same coordinate space. The layer passes
            gestures through (pan/zoom) while each pin re-enables pointer events.
            `.pin-layer` drives the staggered entrance. Each pin's wrapper anchors
            the marker TIP at its point via -translate-x-1/2 -translate-y-full
            (the MapPin/KeepScale recipe). */}
        <div className="pin-layer pointer-events-none absolute inset-0">
          {pins.map((p) => (
            <div
              key={p.key}
              className="pointer-events-auto absolute -translate-x-1/2 -translate-y-full"
              style={{ left: `${p.xPct}%`, top: `${p.yPct}%` }}
              // The photo pin carries its own title; avoid a double tooltip.
              title={p.photoSignId ? undefined : p.title}
            >
              {p.photoSignId ? (
                <DeployPhotoPin
                  signId={p.photoSignId}
                  active={p.active}
                  title={p.title}
                />
              ) : p.href ? (
                <Link href={p.href} aria-label={p.title} className="block">
                  <MapPin active={p.active} toneClass={p.toneClass} />
                </Link>
              ) : (
                <MapPin active={p.active} toneClass={p.toneClass} />
              )}
            </div>
          ))}
        </div>
      </div>
    </ZoomCanvas>
  );
}
