"use client";

// Client-side device context for the adaptive shell. Subscribes to the real form
// factor via matchMedia through useSyncExternalStore: the SERVER snapshot is the
// cookie-seeded `initialDevice` (so first paint + hydration match SSR — no
// mismatch), then React switches to the live measurement and re-renders if it
// differs. The measured value is written back to the df_device cookie so the next
// server render picks the right shell with no flash.

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

import { DEVICE_COOKIE, type Device } from "@/lib/device";

type DeviceContextValue = {
  device: Device;
  isMobile: boolean;
};

const DeviceContext = createContext<DeviceContextValue | null>(null);

// Read the current device from any client component under the provider. Throws
// outside it so a missing provider surfaces immediately rather than silently
// defaulting.
export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevice must be used within DeviceProvider");
  return ctx;
}

// Breakpoint + capability rules (tunable). The installed PWA always gets the
// mobile app shell (display-mode standalone); otherwise a narrow viewport is the
// trigger. Coarse pointer is intentionally NOT decisive — a wide touchscreen
// (e.g. a desk monitor) still gets the desktop layout.
const NARROW = "(max-width: 767px)";
const STANDALONE = "(display-mode: standalone)";

// External-store snapshot: a stable primitive, so useSyncExternalStore's Object.is
// compare settles (recomputing returns the same string until the environment
// actually changes).
function measureDevice(): Device {
  if (typeof window === "undefined") return "desktop";
  const standalone =
    window.matchMedia(STANDALONE).matches ||
    // iOS Safari exposes standalone via a navigator flag, not the media query.
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true;
  if (standalone) return "mobile";
  return window.matchMedia(NARROW).matches ? "mobile" : "desktop";
}

// Re-render the tree whenever the viewport crosses the breakpoint or the app is
// launched/installed as a standalone PWA.
function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(NARROW), window.matchMedia(STANDALONE)];
  queries.forEach((q) => q.addEventListener("change", onChange));
  return () =>
    queries.forEach((q) => q.removeEventListener("change", onChange));
}

export function DeviceProvider({
  initialDevice,
  children,
}: {
  initialDevice: Device;
  children: React.ReactNode;
}) {
  const device = useSyncExternalStore(
    subscribe,
    measureDevice, // client snapshot (live)
    () => initialDevice, // server snapshot (and the first hydration render)
  );

  // Persist the measured value for the next server render — a genuine external
  // write reacting to state, which is what an effect is for. Secure in prod
  // (HTTPS) so the hint isn't sent over plain HTTP; carries no sensitive data.
  useEffect(() => {
    const secure = location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${DEVICE_COOKIE}=${device}; path=/; max-age=31536000; samesite=lax${secure}`;
  }, [device]);

  return (
    <DeviceContext.Provider value={{ device, isMobile: device === "mobile" }}>
      {children}
    </DeviceContext.Provider>
  );
}
