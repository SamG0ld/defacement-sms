// Regression guard for issue #150 (React #418 hydration mismatch). Runs a CLEAN
// Chromium (fresh profile, no extensions — that's the control the issue's triage
// asks for) against a LOCAL DEV build, where React emits the un-minified
// hydration diff and component stack a prod build can't give you.
//
// Manual — see ./README.md for why this isn't in the CI e2e suite yet.
// Usage: npx next dev -p 3037   then   node tests/manual/hydration-check.mjs

import "dotenv/config";
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";
import pg from "pg";

const BASE = `http://localhost:${process.env.MANUAL_TEST_PORT ?? 3037}`;
const EMAIL = "hydration-probe@example.test";
// NextAuth v5 over plain http: no __Secure- prefix. The salt IS the cookie name.
const COOKIE = "authjs.session-token";
const ROUTES = ["/login", "/", "/signs", "/signs/new", "/deploy"];

async function ensureUser() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `INSERT INTO users (id, email, name, role, "isActive", "tokenVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Hydration Probe', 'admin', true, 0, now(), now())
     ON CONFLICT (email) DO UPDATE SET "isActive" = true
     RETURNING id`,
    ["hydration-probe-user", EMAIL],
  );
  await client.end();
  return rows[0].id;
}

async function mintCookie(userId) {
  const token = await encode({
    token: {
      sub: userId,
      userId,
      email: EMAIL,
      role: "admin",
      isActive: true,
      tokenVersion: 0,
      // Fresh, so the jwt callback's staleness refresh doesn't re-run on every hit.
      lastChecked: Date.now(),
    },
    secret: process.env.AUTH_SECRET,
    salt: COOKIE,
    maxAge: 60 * 60,
  });
  return { name: COOKIE, value: token, domain: "localhost", path: "/" };
}

const HYDRATION_RE =
  /hydrat|#418|#423|#425|did not match|server rendered|Minified React error/i;

async function main() {
  const userId = await ensureUser();
  const cookie = await mintCookie(userId);

  const browser = await chromium.launch();

  // /login only renders for a signed-OUT visitor (the authed context bounces to
  // "/"), so probe it in its own cookie-less context first.
  {
    const anon = await browser.newContext();
    const page = await anon.newPage();
    const found = [];
    page.on("console", (m) => {
      if (HYDRATION_RE.test(m.text())) found.push(`[console] ${m.text()}`);
    });
    page.on("pageerror", (e) => {
      if (HYDRATION_RE.test(`${e.message}${e.stack ?? ""}`)) {
        found.push(`[pageerror] ${e.message}`);
      }
    });
    await page.goto(BASE + "/login", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    console.log(`\n=== /login (signed out) -> ${new URL(page.url()).pathname} ===`);
    console.log(found.length ? found.join("\n") : "  no hydration diagnostics");
    await anon.close();
  }

  const context = await browser.newContext();
  await context.addCookies([cookie]);

  // Offline-at-page-load: the show-floor case. The online/offline events only
  // fire on a TRANSITION, so a device that starts offline never gets corrected by
  // them — if connectivity is read during the hydration render, this mismatches.
  {
    const off = await browser.newContext();
    await off.addCookies([cookie]);
    const page = await off.newPage();
    const found = [];
    page.on("pageerror", (e) => {
      if (HYDRATION_RE.test(`${e.message}${e.stack ?? ""}`)) {
        found.push(`[pageerror] ${e.message.split("\n")[0]}`);
      }
    });
    // Load first (the HTML has to arrive), then cut the network and reload from
    // cache is unreliable — instead override navigator.onLine before any app
    // script runs, which is what the hydration render actually reads.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "onLine", {
        get: () => false,
        configurable: true,
      });
    });
    for (const route of ["/signs", "/deploy"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const reported = await page.evaluate(() => navigator.onLine);
      // Silence isn't enough: the UI must still SHOW offline once hydrated,
      // otherwise we'd have "fixed" the mismatch by ignoring connectivity.
      const shown = await page.evaluate(() =>
        (document.body.innerText.match(/Offline|Online/) ?? ["(neither)"])[0],
      );
      console.log(
        `\n=== ${route} (navigator.onLine === ${reported}, UI says "${shown}") ===\n` +
          (found.length ? found.join("\n") : "  no hydration diagnostics"),
      );
      found.length = 0;
    }
    await off.close();
  }

  let hits = 0;
  for (const route of ROUTES) {
    const page = await context.newPage();
    const found = [];
    page.on("console", (m) => {
      const t = m.text();
      if (HYDRATION_RE.test(t)) found.push(`[console.${m.type()}] ${t}`);
    });
    page.on("pageerror", (e) => {
      const t = `${e.message}\n${e.stack ?? ""}`;
      if (HYDRATION_RE.test(t)) found.push(`[pageerror] ${t}`);
    });

    const res = await page.goto(BASE + route, { waitUntil: "networkidle" });
    // React reports hydration diffs in a passive effect — give it a beat.
    await page.waitForTimeout(1500);

    const status = res?.status() ?? "?";
    const finalUrl = new URL(page.url()).pathname;
    console.log(`\n=== ${route} -> ${finalUrl} (${status}) ===`);
    if (found.length === 0) {
      console.log("  no hydration diagnostics");
    } else {
      hits += found.length;
      for (const f of found) console.log("  " + f.slice(0, 4000));
    }
    await page.close();
  }

  await browser.close();
  console.log(`\nTOTAL hydration diagnostics: ${hits}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
