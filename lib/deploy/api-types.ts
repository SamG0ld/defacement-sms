// Auth-free primitives shared by the deploy service + the route layer. Kept
// separate from api-session.ts so the service layer (and its integration tests)
// don't transitively import next-auth / next/server just to reference these.

import type { UserRole } from "@/app/generated/prisma/client";

// The resolved acting user for an /api/native/* request, however it authed
// (cookie session today; bearer in Phase A2). The service layer takes this
// directly so it never touches request context.
export type ApiActor = {
  userId: string;
  email: string | null;
  role: UserRole;
};

// A failure with an explicit HTTP status. `runApi` (api-session.ts) maps it to a
// JSON response; the service throws it for 403/404 conditions.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
