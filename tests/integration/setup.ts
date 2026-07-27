import "./load-env"; // must run before @/lib/db reads DATABASE_URL
import { afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db";

// Clean slate before each test. Truncates the domain tables that tests write to
// and CASCADEs to their children (status_history, sign_tag_assignments,
// crew_members); the seeded reference data (zones, tags, equipment types) is
// preserved. deploy_events and sign_stock_checkouts are FK-free, so they're
// truncated explicitly (a signs TRUNCATE won't cascade to them).
beforeEach(async () => {
  // Tagged-template form (no $executeRawUnsafe): the statement is a compile-time
  // constant with no interpolation, so this is the parameterized-safe equivalent —
  // and keeps the unsafe API from gaining a foothold in the codebase (M17 #56).
  await prisma.$executeRaw`TRUNCATE TABLE "signs", "status_history", "audit_log", "equipment_inventory", "crews", "crew_members", "deploy_events", "sign_stock_checkouts", "generation_batches" RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});
