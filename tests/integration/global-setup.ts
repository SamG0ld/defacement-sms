import "./load-env";
import { execSync } from "node:child_process";

// Runs once before the integration suite: migrate + seed the test database.
// Guarded so it can never run against a non-test DB.
//
// Match the DATABASE NAME only (the URL path), never the whole connection
// string — otherwise a host/credential containing the substring "test" (e.g. a
// Neon endpoint id like "ep-xxxx-...") would falsely arm a destructive
// TRUNCATE. ALLOW_TEST_DB_RESET is the explicit escape hatch (CI uses it against
// its throwaway container).
function looksLikeTestDb(url: string): boolean {
  if (process.env.ALLOW_TEST_DB_RESET === "1") return true;
  try {
    const dbName = new URL(url).pathname.replace(/^\//, "");
    return /test/i.test(dbName);
  } catch {
    return false;
  }
}

export default function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[integration] No DATABASE_URL. Copy .env.test.example to .env.test and point it " +
        "at a DISPOSABLE Postgres (a Neon test branch or throwaway local DB).",
    );
  }
  if (!looksLikeTestDb(url)) {
    throw new Error(
      "[integration] Refusing to run: DATABASE_URL does not look like a test database " +
        '(its name lacks "test" and ALLOW_TEST_DB_RESET is unset). This suite migrates, ' +
        "seeds, and TRUNCATEs — point it at a disposable DB.",
    );
  }

  // execSync inherits process.env (DATABASE_URL is the test DB from load-env);
  // prisma.config.ts loads .env without override, so it cannot clobber it.
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  execSync("npx prisma db execute --file prisma/seeds/reference-data.sql", {
    stdio: "inherit",
  });
  // Floor maps live in a bytea column, so they're seeded by a small pg script
  // rather than a .sql file. Runs after reference-data (it links maps to zones).
  // dotenv/config inside the script won't override the inherited test
  // DATABASE_URL (no-override is dotenv's default), so it targets the test DB.
  execSync("node prisma/seeds/seed-floor-maps.mjs", { stdio: "inherit" });
  execSync("npx prisma db execute --file prisma/seeds/equipment-types.sql", {
    stdio: "inherit",
  });
}
