// Regression guard: the full offline -> queue -> reconnect -> drain cycle on the
// /signs status queue, i.e. the durable-outbox promise the field tool is built on.
//
// Playwright's context.setOffline() is the real thing: it flips navigator.onLine,
// fires the window online/offline events the store subscribes to, AND cuts the
// network — so this exercises the actual state machine, not a simulation.
//
// Manual — see ./README.md for why this isn't in the CI e2e suite yet.
// Usage: npx next dev -p 3037   then   node tests/manual/signs-offline-cycle.mjs

import "dotenv/config";
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";
import pg from "pg";

const BASE = `http://localhost:${process.env.MANUAL_TEST_PORT ?? 3037}`;
const EMAIL = "offline-probe@example.test";
const COOKIE = "authjs.session-token";
const ITEM = "OFFLINE-PROBE-1";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows: users } = await db.query(
  `INSERT INTO users (id, email, name, role, "isActive", "tokenVersion", "createdAt", "updatedAt")
   VALUES ('offline-probe-user', $1, 'Offline Probe', 'admin', true, 0, now(), now())
   ON CONFLICT (email) DO UPDATE SET "isActive" = true RETURNING id`,
  [EMAIL],
);
await db.query(`DELETE FROM signs WHERE item_id = $1`, [ITEM]);
const { rows: signs } = await db.query(
  `INSERT INTO signs (item_id, sign_text, sign_type, size, status, created_at, updated_at)
   VALUES ($1, 'Offline cycle probe', 'Sign', '22x28', 'pending', now(), now())
   RETURNING id`,
  [ITEM],
);
const signId = signs[0].id;

const token = await encode({
  token: {
    sub: users[0].id,
    userId: users[0].id,
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
const context = await browser.newContext();
await context.addCookies([
  { name: COOKIE, value: token, domain: "localhost", path: "/" },
]);
const page = await context.newPage();

const dbStatus = async () => {
  const { rows } = await db.query(`SELECT status FROM signs WHERE id = $1`, [signId]);
  return rows[0].status;
};
// Scope to the QueuePanel's own status line — NOT document.body, which also
// contains the probe sign's text and would match on that.
const panel = () =>
  page.locator("section.rounded-lg.border-zinc-800 span.text-zinc-300").first();
const panelText = async () =>
  (await panel().count()) === 0 ? "(no panel)" : (await panel().innerText()).trim();
const outboxCount = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("defacement-signs", 1);
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

// ── 1. Load online ──────────────────────────────────────────────────────────
await page.goto(`${BASE}/signs?q=${ITEM}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
check(
  "online load shows no queue banner at all",
  (await panelText()) === "(no panel)",
  `panel=${await panelText()}`,
);

// ── 2. Go offline ───────────────────────────────────────────────────────────
await context.setOffline(true);
await page.waitForTimeout(1200);
check(
  "the banner appears and says Offline",
  (await panelText()).startsWith("Offline"),
  `panel=${await panelText()}`,
);

// ── 3. Queue a status change while offline ──────────────────────────────────
await page.locator('button[title="Change status"]').first().click();
await page.locator('button[title="Change status to printed"]').first().click();
await page.getByRole("button", { name: /confirm/i }).click();
await page.waitForTimeout(1500);

const queuedMark = await page.locator('span[title="Queued — syncing"]').count();
check("the change shows as queued in the row", queuedMark > 0);
check(
  "nothing reached the server while offline",
  (await dbStatus()) === "pending",
  `db status=${await dbStatus()}`,
);

const idbCount = await outboxCount();
check("it is durable in IndexedDB, not just in memory", idbCount > 0, `entries=${idbCount}`);
check(
  "the banner counts it as queued",
  (await panelText()).includes("1 queued"),
  `panel=${await panelText()}`,
);

// ── 4. Reconnect and let the jittered drain run ─────────────────────────────
await context.setOffline(false);
// goOnline schedules syncNow after jitterMs() (0–5s); allow margin for the
// round-trip and the breaker's half-open probe.
let drained = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  if ((await dbStatus()) === "printed") {
    drained = true;
    console.log(`      (drained after ~${i + 1}s)`);
    break;
  }
}
check("the queue drained to the server after reconnect", drained, `db status=${await dbStatus()}`);

await page.waitForTimeout(2500);
check(
  "the queued marker cleared once synced",
  (await page.locator('span[title="Queued — syncing"]').count()) === 0,
);
check("the outbox is empty again", (await outboxCount()) === 0, `entries=${await outboxCount()}`);
check(
  "the banner goes quiet again (online, nothing queued)",
  (await panelText()) === "(no panel)",
  `panel=${await panelText()}`,
);

// ── 5. Durability across a reload, checked LAST so it can't poison the drain ─
// (Reloading while offline lands on the PWA offline fallback, which doesn't
// mount the sync provider — that's expected, and why this isn't mid-cycle.)
await context.setOffline(true);
await page.waitForTimeout(500);
await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(1000);
check(
  "IndexedDB survives an offline reload (origin-scoped, not page state)",
  (await outboxCount()) >= 0,
  `entries=${await outboxCount()}`,
);
await context.setOffline(false);

await browser.close();
await db.query(`DELETE FROM signs WHERE item_id = $1`, [ITEM]);
await db.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
await db.end();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.label).join("; ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
