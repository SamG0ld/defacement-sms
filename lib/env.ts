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
  // Vercel Blob token for deploy photos (lib/deploy/blob.ts). Required in prod so
  // a deploy without it fails at startup instead of silently throwing the first
  // time a crew uploads a photo from the floor.
  "BLOB_READ_WRITE_TOKEN",
] as const;

export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing = REQUIRED_PROD_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
}
