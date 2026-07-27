"use client";

import { useEffect } from "react";

import * as Sentry from "@sentry/nextjs";

// Tags browser-side Sentry events with the acting user's OPAQUE id (the CUID, never
// the email) so an error a volunteer hits can be tied to "which user" during triage
// — without sending PII. Mounted in the authenticated layout; a complete no-op when
// Sentry has no DSN. Renders nothing.
export function SentryUser({ userId }: { userId: string }) {
  useEffect(() => {
    Sentry.setUser({ id: userId });
    return () => Sentry.setUser(null);
  }, [userId]);
  return null;
}
