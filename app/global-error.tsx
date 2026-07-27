"use client";

import { useEffect } from "react";

import * as Sentry from "@sentry/nextjs";

// global-error replaces the ROOT layout when the error is thrown in the layout
// itself, so it must render its own <html>/<body>. The failed root layout's
// fonts/theme tokens aren't guaranteed here, so colors use plain Tailwind utility
// classes (always available) rather than the theme custom-properties.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to Sentry (no-op without a DSN); a layout-level crash lands here.
    // Tag with `digest` so the user-facing reference code correlates to the
    // server-side log for this error (see #89).
    Sentry.captureException(error, { tags: { digest: error.digest } });
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        {/* global-error replaces the root layout, so Next injects no automatic
            metadata here — set charset + viewport ourselves or the error screen
            mis-renders on mobile. */}
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="flex min-h-screen items-center justify-center bg-zinc-950 p-4 text-zinc-100">
        <div className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center shadow-2xl">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-xs text-zinc-400">
              The app hit an unexpected error. Please try again.
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
          >
            Try again
          </button>
          {error.digest ? (
            <p className="text-[11px] text-zinc-600">Reference: {error.digest}</p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
