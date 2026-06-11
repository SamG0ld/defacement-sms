import "./load-env"; // must run before @/lib/db reads DATABASE_URL
import { afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db";

// Clean slate before each test. Truncates the domain tables that tests write to
// and CASCADEs to their children (status_history, sign_tag_assignments,
// crew_members); the seeded reference data (zones, tags, equipment types) is
// preserved. deploy_events is FK-free, so it's truncated explicitly.
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "signs", "status_history", "audit_log", "equipment_inventory", "crews", "crew_members", "deploy_events", "generation_batches" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
