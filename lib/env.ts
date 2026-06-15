// Production env preflight. In production, missing critical config should fail
// loudly at server startup rather than silently degrade — e.g. the rate limiter
// (lib/ratelimit.ts) otherwise disables itself when Upstash vars are absent,
// removing brute-force protection on /api/auth with no signal. No-op outside
// production so local dev stays zero-config.
const REQUIRED_PROD_ENV = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  // Magic-link email (Resend). Required in prod so a misconfigured deploy fails
  // loud rather than silently leaving teammates who can't use Google OAuth
  // without a way in.
  "AUTH_RESEND_KEY",
  "EMAIL_FROM",
] as const;

export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing: string[] = REQUIRED_PROD_ENV.filter((key) => !process.env[key]);
  // Vercel Blob (deploy/sign photos, lib/blob-image.ts) authenticates with EITHER
  // a static read-write token OR OIDC (BLOB_STORE_ID + the platform-injected,
  // auto-rotated VERCEL_OIDC_TOKEN). Connecting a store via "Connect to Project"
  // provisions OIDC (BLOB_STORE_ID), not BLOB_READ_WRITE_TOKEN — and the app only
  // does server-side put/get/del, which OIDC fully supports. Require either, so a
  // deploy with no blob credential still fails loudly, but an OIDC-connected
  // store isn't rejected for lacking the legacy static token.
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    missing.push("BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
  // AUTH_SECRET signs every session JWT — a guessable value forges sessions, so
  // presence alone isn't enough: reject the .env.example placeholder and
  // anything shorter than the 32 chars `openssl rand -base64 32` produces.
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret === "change-me" || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET is too weak for production (placeholder or under 32 chars). " +
        "Generate one with: openssl rand -base64 32",
    );
  }
}
