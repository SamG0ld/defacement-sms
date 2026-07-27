import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // Bound the pg pool so a burst of concurrent serverless invocations can't
  // exhaust the database's connection cap (low free-tier ceilings are common).
  // Use the POOLED connection string (PgBouncer) for DATABASE_URL in production — see
  // DEPLOY.md.
  const adapter = new PrismaPg({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    // A scale-to-zero database parks its compute when idle; the first connection
    // after a cold period has to wait for it to wake. 4s gives that wake room on
    // the first attempt (a typical wake is well under that), and lib/db-retry.ts
    // (`withDbRetry`) retries a still-transient blip once more, which supplies a
    // second wake window — together they keep a cold start from 500ing auth.
    //
    // The retry has to FIT the function budget or it turns a graceful recovery
    // into a hard platform timeout, so the worst case is pinned rather than
    // assumed (#249). Per withDbRetry CALL (1 retry, 300ms * attempt backoff):
    //
    //     4s connect + 0.3s backoff + 4s retry = 8.3s
    //
    // At the old 6s that was ~12.3s, which a 10s function ceiling would have
    // killed mid-retry — the exact failure the retry exists to avoid. 8.3s
    // clears the most conservative Vercel ceiling on any plan, so this holds
    // without depending on an unverified plan default.
    //
    // Note this is PER CALL, not per request: a first-time sign-in chains
    // several DB ops through the lib/auth.ts JWT callback (user lookup at :275,
    // login stamp at :348, plus recordAudit), so a pathological all-cold
    // request can still stack multiples of 8.3s. Only the lookup runs on a
    // routine session refresh. Don't cite the 8.3s figure as the whole-request
    // budget, and re-derive both numbers before raising this value.
    connectionTimeoutMillis: 4_000,
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
