import type { ReactElement, SVGProps } from "react";

// Inline SVG icon set for the app shell + content screens (stroke = currentColor,
// so each icon takes the surrounding text color). Metaphors from the DC34 design:
// crosshair = Deploy (covert-ops), box = Inventory, pulse = Activity. A small
// in-house set — no icon dependency, sized at the call site via width/height.
type IconProps = SVGProps<SVGSVGElement>;

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const Icons = {
  signs: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="M12 3v3" />
      <rect x="3" y="6" width="13" height="6" rx="1.5" />
      <rect x="6" y="13" width="13" height="6" rx="1.5" />
      <path d="M12 19v2" />
    </svg>
  ),
  deploy: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 1.6v3.4M12 19v3.4M1.6 12h3.4M19 12h3.4" />
    </svg>
  ),
  inventory: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="M3 8l9-4.5L21 8v8L12 20.5 3 16z" />
      <path d="M3 8l9 4.5L21 8" />
      <path d="M12 12.5V20.5" />
    </svg>
  ),
  activity: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="M2.5 12h4l2.5-6 4 13 2.5-7h6" />
    </svg>
  ),
  map: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6 9 3.5z" />
      <path d="M9 3.5V18M15 6v14.5" />
    </svg>
  ),
  users: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 19.5a5.5 5.5 0 0 0-3-4.9" />
    </svg>
  ),
  more: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  ),
  search: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  easel: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <rect x="5" y="3" width="14" height="10" rx="1" />
      <path d="M7 13l-2 8M17 13l2 8M6 18h12" />
    </svg>
  ),
  signout: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </svg>
  ),
  chevron: (p: IconProps): ReactElement => (
    <svg {...base} {...p}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
};

export type IconName = keyof typeof Icons;
