// Regression guard: the offline -> queue -> reconnect -> drain cycle on the FIELD
// DEPLOY PWA (/deploy), plus the server-unreachable-while-navigator-says-online
// branch (captive portal / dead backhaul) that navigator.onLine cannot see.
//
// Runs at a phone viewport with the device cookie pinned to mobile, so it drives
// the same single-column field flow a crew actually uses (row tap = select).
//
// Manual — see ./README.md for why this isn't in the CI e2e suite yet.
// Usage: npx next dev -p 3037   then   node tests/manual/deploy-offline-cycle.mjs

import "dotenv/config";
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";
import pg from "pg";

const BASE = `http://localhost:${process.env.MANUAL_TEST_PORT ?? 3037}`;
const EMAIL = "deploy-probe@example.test";
const COOKIE = "authjs.session-token";
const ITEM = "DEPLOY-PROBE-1";
const USER_ID = "deploy-probe-user";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ── Seed: probe user, a crew they belong to, and one claimable (sorted) sign ──
await db.query(
  `INSERT INTO users (id, email, name, role, "isActive", "tokenVersion", "createdAt", "updatedAt")
   VALUES ($1, $2, 'Deploy Probe', 'admin', true, 0, now(), now())
   ON CONFLICT (email) DO UPDATE SET "isActive" = true`,
  [USER_ID, EMAIL],
);
await db.query(`DELETE FROM signs WHERE item_id = $1`, [ITEM]);
await db.query(`DELETE FROM crews WHERE name = 'Probe Crew'`); // cascades members
const { rows: crews } = await db.query(
  `INSERT INTO crews (name, created_by_user_id, is_active, created_at)
   VALUES ('Probe Crew', $1, true, now()) RETURNING id`,
  [USER_ID],
);
const crewId = crews[0].id;
await db.query(
  `INSERT INTO crew_members (crew_id, user_id, joined_at) VALUES ($1, $2, now())`,
  [crewId, USER_ID],
);
const { rows: signs } = await db.query(
  `INSERT INTO signs (item_id, sign_text, sign_type, size, status, created_at, updated_at)
   VALUES ($1, 'Deploy cycle probe', 'Sign', '22x28', 'sorted', now(), now())
   RETURNING id`,
  [ITEM],
);
const signId = signs[0].id;

const token = await encode({
  token: {
    sub: USER_ID,
    userId: USER_ID,
    email: EMAIL,
    role: "admin",
    isActive: true,
    tokenVersion: 0,
    lastChecked: Date.now(),
  },
  secret: process.env.AUTH_SECRET,
  salt: COOKIE,
  maxAge: 3600,
});

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([
  { name: COOKIE, value: token, domain: "localhost", path: "/" },
  // Pin the shell to the mobile layout so SSR and the client agree from the start.
  { name: "df_device", value: "mobile", domain: "localhost", path: "/" },
]);
const page = await context.newPage();
// Pre-seed the active crew the way the CrewBar would, so the test drives the
// claim flow rather than the crew picker.
await page.addInitScript(
  ([key, id]) => localStorage.setItem(key, id),
  ["deploy.activeCrewId", String(crewId)],
);

const claimState = async () => {
  const { rows } = await db.query(
    `SELECT claimed_by_crew_id AS crew, status FROM signs WHERE id = $1`,
    [signId],
  );
  return rows[0];
};
// The header connectivity pill, scoped so the probe sign's own text can't match.
const badge = async () => {
  const el = page.locator('span[aria-live="polite"]').first();
  return (await el.count()) === 0 ? "(none)" : (await el.innerText()).trim();
};
const outboxCount = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("defacement-deploy", 1);
        open.onsuccess = () => {
          const dbh = open.result;
          if (!dbh.objectStoreNames.contains("outbox")) return resolve(-1);
          const all = dbh.transaction("outbox").objectStore("outbox").getAll();
          all.onsuccess = () => resolve(all.result.length);
          all.onerror = () => resolve(-1);
        };
        open.onerror = () => resolve(-1);
      }),
  );

// ── 1. Load online, wait for the client bootstrap ───────────────────────────
await page.goto(`${BASE}/deploy`, { waitUntil: "networkidle" });
await page
  .getByText("Deploy cycle probe", { exact: false })
  .first()
  .waitFor({ timeout: 20000 })
  .catch(() => {});
check("the field list bootstraps and shows the claimable sign",
  (await page.getByText("Deploy cycle probe").count()) > 0);
check("it reports Online to start", (await badge()) === "Online", `badge=${await badge()}`);

// ── 2. Go offline ───────────────────────────────────────────────────────────
await context.setOffline(true);
await page.waitForTimeout(1200);
check("the badge flips to Offline on the transition", (await badge()) === "Offline",
  `badge=${await badge()}`);

// ── 3. Claim the sign while offline ─────────────────────────────────────────
await page.getByText("Deploy cycle probe").first().click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^claim/i }).click();
await page.waitForTimeout(1500);

check("nothing reached the server while offline",
  (await claimState()).crew === null, `db crew=${(await claimState()).crew}`);
const queued = await outboxCount();
check("the claim is durable in IndexedDB", queued > 0, `entries=${queued}`);
check("the header shows the queued count", /queued/i.test(await page.innerText("header")),
  `header="${(await page.innerText("header")).replace(/\s+/g, " ").trim()}"`);

// ── 4. Reconnect and let the jittered drain run ─────────────────────────────
await context.setOffline(false);
let drained = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  if ((await claimState()).crew === crewId) {
    drained = true;
    console.log(`      (drained after ~${i + 1}s)`);
    break;
  }
}
const after = await claimState();
check("the claim drained to the server after reconnect", drained, `db crew=${after.crew}`);
check("the sign stayed `sorted` (a claim is a lock, not a status change)",
  after.status === "sorted", `db status=${after.status}`);

await page.waitForTimeout(2500);
check("it reports Online again", (await badge()) === "Online", `badge=${await badge()}`);
check("the outbox is empty again", (await outboxCount()) === 0,
  `entries=${await outboxCount()}`);

// ── 5. Server unreachable while the BROWSER still claims to be online ───────
// The captive-portal / dead-backhaul case. This is the second input of the split
// `online = browserOnline && serverReachable`, and the only one navigator can't
// see — so it's the branch most at risk from the restructure.
await page.route("**/api/native/sync/**", (route) => route.abort("failed"));
await page.evaluate(() => window.dispatchEvent(new Event("online"))); // force a sync attempt
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(1000);
  if ((await badge()) === "Offline") break;
}
check(
  "a failed sync still reports Offline even though navigator.onLine is true",
  (await badge()) === "Offline" && (await page.evaluate(() => navigator.onLine)) === true,
  `badge=${await badge()}, navigator.onLine=${await page.evaluate(() => navigator.onLine)}`,
);
await page.unroute("**/api/native/sync/**");
await page.evaluate(() => window.dispatchEvent(new Event("online")));
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(1000);
  if ((await badge()) === "Online") break;
}
check("and recovers to Online once the server answers again", (await badge()) === "Online",
  `badge=${await badge()}`);

await browser.close();
await db.query(`DELETE FROM signs WHERE item_id = $1`, [ITEM]);
await db.query(`DELETE FROM crews WHERE id = $1`, [crewId]);
await db.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
await db.end();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.label).join("; ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
