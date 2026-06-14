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
  // exhaust Neon's connection cap (low free-tier ceiling). Use the POOLED Neon
  // connection string (-pooler / PgBouncer) for DATABASE_URL in production — see
  // DEPLOY.md.
  const adapter = new PrismaPg({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    // Neon scale-to-zero parks the compute when idle; the first connection after
    // a cold period has to wait for it to wake. 6s gives that wake room on the
    // first attempt, and lib/db-retry.ts (`withDbRetry`) retries a still-transient
    // blip once more — together they keep a cold start from 500ing auth while
    // staying well under the serverless function budget even with the retry.
    connectionTimeoutMillis: 6_000,
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
