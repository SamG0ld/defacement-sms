import { randomBytes, createHash, timingSafeEqual } from "crypto";

// ⚠ NOT YET WIRED — parked for the invitation flow (see README roadmap).
// Nothing under app/ calls these helpers yet, which means the security
// properties they imply (token expiry, single-use) are NOT enforced anywhere.
// Don't cite this file as evidence the invitation flow is protected until a
// caller actually lands.

// 32 random bytes encoded as base64url ≈ 43 chars, ~256 bits of entropy.
// Plenty for a one-time invitation link.
const TOKEN_BYTES = 32;

export type InvitationToken = {
  /** The cleartext token. Goes into the email link only — never stored. */
  plaintext: string;
  /** The SHA-256 hex hash. This is what gets persisted in the DB. */
  hash: string;
};

export function generateInvitationToken(): InvitationToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString("base64url");
  return { plaintext, hash: hashInvitationToken(plaintext) };
}

export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Compare a candidate plaintext token against a stored hash in constant time
 * to defeat timing attacks. Hashes are hex strings of equal length so this is
 * safe to call directly on the buffer pair.
 */
export function verifyInvitationToken(
  candidatePlaintext: string,
  storedHash: string,
): boolean {
  const candidateHash = hashInvitationToken(candidatePlaintext);
  if (candidateHash.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(candidateHash), Buffer.from(storedHash));
}
