// Loading-skeleton primitive: a tinted shimmer block. The color + shimmer live
// in the `.skeleton` class (globals.css — token-derived and reduced-motion-safe);
// callers pass ONLY layout utilities, same convention as .btn-primary / .badge-*.
// aria-hidden keeps the placeholder out of the a11y tree (the route is announced
// as loading by Next's loading.tsx boundary).
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}
