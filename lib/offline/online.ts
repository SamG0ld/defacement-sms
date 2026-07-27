// Is this device online right now?
//
// Call it AFTER hydration (in an effect), never as a render-path seed — see
// issue #150. Anything that renders off connectivity must seed from a constant
// the server also produces and adopt this value once mounted; measuring during
// the hydration render is itself a mismatch on a device that is genuinely
// offline at page load.
//
// Feature-detects `navigator.onLine` rather than `navigator` itself: Node 22+
// defines a global `navigator` (userAgent only), so the older
// `typeof navigator === "undefined" ? true : navigator.onLine` guard silently
// stopped detecting the server and read an `undefined` — falsy — `onLine`, which
// SSR'd the OFFLINE branch on every request. Callers on the server (or any
// runtime without the property) get the optimistic `true`, matching the seed.
export function isOnlineNow(): boolean {
  return typeof navigator === "undefined" ||
    typeof navigator.onLine !== "boolean"
    ? true
    : navigator.onLine;
}

// Subscription half of the pair, for useSyncExternalStore(subscribeOnline,
// isOnlineNow, () => true) — React's supported way to read a browser signal that
// SSR can't see: the constant server snapshot renders on both sides, then React
// swaps in the measured value after hydration commits. Same shape the app shell's
// LINK indicator already uses (app/(app)/_components/AppShell.tsx).
export function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
