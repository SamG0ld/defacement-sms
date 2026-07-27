import { redirect } from "next/navigation";

import type { UserRole } from "@/app/generated/prisma/client";
import { hasRole } from "@/lib/rbac";
import { getSession } from "@/lib/session";

// Redirecting access guards for Server Components in the (app) tree (M17 #57).
//
// The (app) layout already redirects unauthenticated/deactivated users, but each
// protected page enforces its own access too — defense in depth, so the page is
// never relying on the layout alone — and does it uniformly through these helpers
// instead of ad-hoc inline `session.user.role === ...` comparisons scattered in
// view logic (which drift independently).
//
// Pages redirect on failure (a friendly bounce); the native API routes use the
// *throwing* requireSession / requireRole from lib/rbac.ts instead (mapped to
// 401/403). Both share hasRole as the single rank check.

// Require an authenticated, active session. Redirects to /login otherwise.
// Returns the (non-null) session so the caller can read user fields directly.
export async function requirePageSession() {
  const session = await getSession();
  if (!session?.user?.id || !session.user.isActive) {
    redirect("/login");
  }
  return session;
}

// Require at least `required` role. Redirects an unauthenticated user to /login
// and an authenticated-but-under-privileged user to `fallback` (default "/").
export async function requirePageRole(required: UserRole, fallback = "/") {
  const session = await requirePageSession();
  if (!hasRole(session.user.role, required)) {
    redirect(fallback);
  }
  return session;
}
