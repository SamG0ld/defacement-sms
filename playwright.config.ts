import { defineConfig, devices } from "@playwright/test";

// Unauthenticated smoke only: confirms the app boots and the auth gate works.
// Runs against `next dev` (avoids instrumentation.ts assertProdEnv). Uses the
// default dev port and reuses a running dev server locally — Next 16 allows only
// one dev server per project dir, so a second instance would be refused. In CI
// (no server running) Playwright starts its own.
const PORT = 3000;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // The smoke never writes — it only renders /login and checks the redirect
      // gate (which runs in middleware before any DB query), so these can be
      // throwaway values just sufficient for the app to boot.
      AUTH_SECRET: process.env.AUTH_SECRET ?? "smoke-test-secret-not-real",
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgresql://localhost:5432/unused",
      // Dummy OAuth creds so the Google provider constructs cleanly at boot; the
      // smoke never performs a sign-in handshake.
      AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID ?? "smoke-google-id",
      AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET ?? "smoke-google-secret",
      NEXTAUTH_URL: `http://localhost:${PORT}`,
    },
  },
});
