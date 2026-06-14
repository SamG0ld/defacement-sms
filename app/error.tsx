"use client";

import { useEffect } from "react";

// Route-segment error boundary for the whole app tree (everything below the root
// layout, including /login and the authed area). Without it, a thrown server
// error renders Next's raw default screen. Matches the login aesthetic.
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the browser console; Next captures the full stack server-side
    // and ties it to this digest.
    console.error(error);
  }, [error]);

  return (
    <div className="relative flex min-h-full flex-1 items-center justify-center overflow-hidden bg-zinc-950 p-4">
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8 text-center text-zinc-100 shadow-2xl shadow-black/50">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-xs text-zinc-400">
            A temporary error occurred. This usually clears on a retry.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="btn-primary w-full rounded px-4 py-2 text-sm font-medium"
          >
            Try again
          </button>
          <a
            href="/login"
            className="text-xs text-zinc-400 underline-offset-2 hover:underline"
          >
            Back to sign in
          </a>
        </div>
        {error.digest ? (
          <p className="text-[11px] text-zinc-600">Reference: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
