import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Two projects:
//  - "unit": pure domain/lib logic, no DB, always runnable (`npm test`).
//  - "integration": real Prisma against a disposable test Postgres; needs a test
//    DATABASE_URL and runs serially. Invoked explicitly (`npm run test:integration`).
// The `@/*` -> `./*` path alias from tsconfig.json is resolved natively by Vite.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // The real `server-only` package throws on import outside a server bundle, so
    // alias it to a no-op for the node test envs (server modules like
    // lib/figma-api.ts are pulled in via the generate Server Actions).
    alias: {
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          // DB tests share one database + truncate between tests, so they must
          // not run in parallel across files.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // Gate coverage on the pure modules the unit suite actually targets — not
      // pages/Server Actions/UI, which a global threshold would falsely fail.
      include: [
        "**/signs/_lib.ts",
        "**/import/_parse.ts",
        "**/import/_map.ts",
        "**/import/_parsers/*.ts",
        "lib/print-summary.ts",
        "lib/csv.ts",
        "lib/deploy/resolve.ts",
        "lib/offline/*.ts",
        "**/deploy/_lib/sync.ts",
        "**/deploy/_lib/outbox.ts",
        "**/deploy/_lib/api.ts",
        "**/deploy/_lib/idb.ts",
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
