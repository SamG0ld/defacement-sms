"use client";

import { useEffect } from "react";

// Registers the offline-shell service worker (public/sw.js) once, on the client,
// after hydration. Mounted globally from the root layout so the shell is cached
// even before sign-in. Renders nothing.
//
// `updateViaCache: "none"` makes the browser revalidate sw.js on every load
// (paired with the no-cache header in next.config.ts) so a new worker ships
// without users having to hard-refresh. Registration failure is non-fatal — the
// app works without offline support; we just log it.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((err) => {
          console.error("service worker registration failed", err);
        });
    };
    // Register after load so the SW install doesn't contend with first paint.
    if (document.readyState === "complete") {
      onLoad();
    } else {
      window.addEventListener("load", onLoad, { once: true });
      return () => window.removeEventListener("load", onLoad);
    }
  }, []);

  return null;
}
