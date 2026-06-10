import { auth } from "@/lib/auth";
import type { UserRole } from "@/app/generated/prisma/client";

const ROLE_RANK: Record<UserRole, number> = {
  volunteer: 1,
  lead: 2,
  admin: 3,
};

export function hasRole(actual: UserRole, required: UserRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export class AuthorizationError extends Error {
  constructor(public required: UserRole, public actual?: UserRole) {
    super(
      actual
        ? `Requires role '${required}', user has '${actual}'`
        : `Requires role '${required}', user is not authenticated`,
    );
    this.name = "AuthorizationError";
  }
}

export async function requireSession() {
  const session = await auth();
  // Reject unauthenticated AND deactivated / kill-switched users. The jwt
  // callback sets isActive=false for them while keeping user.id populated, so
  // an id check alone would let a revoked session through here.
  if (!session?.user?.id || !session.user.isActive) {
    throw new AuthorizationError("volunteer");
  }
  return session;
}

export async function requireRole(required: UserRole) {
  const session = await requireSession();
  const role = session.user.role;

  if (!hasRole(role, required)) {
    throw new AuthorizationError(required, role);
  }

  return session;
}
