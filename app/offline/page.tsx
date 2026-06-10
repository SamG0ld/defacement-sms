import type { Metadata } from "next";

// Offline fallback. Served from the service-worker cache (public/sw.js) when a
// navigation has no network and nothing else is cached. Deliberately static and
// public (see proxy.ts PUBLIC_PREFIXES) — it carries no user data and must render
// without a session or a server round-trip. The real floor tool (/deploy) keeps
// working offline from its own IndexedDB outbox; this page is only the last-resort
// shell for an uncached cold navigation.
export const metadata: Metadata = {
  title: "Offline · Defacement SMS",
};

export default function OfflinePage() {
  return (
    <main className="dot-grid flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-accent">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-zinc-400">
        No network right now — that&apos;s expected on the floor. Anything you
        claimed or deployed is saved on this device and will sync automatically
        when the signal comes back.
      </p>
      <p className="text-xs text-zinc-500">
        Reopen the app once you have a connection to push your queue.
      </p>
    </main>
  );
}
