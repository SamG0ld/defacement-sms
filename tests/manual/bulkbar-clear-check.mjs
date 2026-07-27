// Repro harness for issue #149: bulk-toolbar "clear" leaves the toolbar armed
// under REAL (trusted) clicks, while a synthetic element.click() sequence passes.
//
// Playwright's page.click() drives CDP Input events => trusted, isTrusted=true,
// separate task per event — the exact condition #149 says breaks the dismissal.
// The synthetic control uses element.click() inside one page.evaluate() task.
//
// Usage: npx next dev -p 3043   then   node <this file>

import "dotenv/config";
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";
import pg from "pg";

const BASE = `http://localhost:${process.env.MANUAL_TEST_PORT ?? 3043}`;
const EMAIL = "bulkbar-probe@example.test";
const COOKIE = "authjs.session-token";

async function ensureUser() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `INSERT INTO users (id, email, name, role, "isActive", "tokenVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, 'BulkBar Probe', 'admin', true, 0, now(), now())
     ON CONFLICT (email) DO UPDATE SET "isActive" = true
     RETURNING id`,
    ["bulkbar-probe-user", EMAIL],
  );
  const { rows: cnt } = await client.query(
    `SELECT count(*)::int AS n FROM signs WHERE status <> 'archived'`,
  );
  await client.end();
  console.log(`  signs available: ${cnt[0].n}`);
  return rows[0].id;
}

// Leave nothing behind: an admin row that outlives the run would be a standing
// principal if this were ever pointed at anything but a disposable worktree DB.
async function removeUser() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await client.end();
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
      lastChecked: Date.now(),
    },
    secret: process.env.AUTH_SECRET,
    salt: COOKIE,
    maxAge: 60 * 60,
  });
  return { name: COOKIE, value: token, domain: "localhost", path: "/" };
}

// Records every mount/unmount of .bulkbar and every data-exiting flip, so we can
// tell "exit never started" from "exit started but never finished".
const OBSERVER = () => {
  const log = [];
  window.__bulkbarLog = log;
  const stamp = (what) =>
    log.push(`${String(performance.now().toFixed(0)).padStart(6)}ms  ${what}`);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target.classList?.contains("bulkbar")) {
        stamp(
          `attr ${r.attributeName} -> ${JSON.stringify(r.target.getAttribute(r.attributeName))}`,
        );
      }
      for (const n of r.addedNodes ?? []) {
        if (
          n.nodeType === 1 &&
          (n.matches?.(".bulkbar") || n.querySelector?.(".bulkbar"))
        )
          stamp("bulkbar MOUNTED");
      }
      for (const n of r.removedNodes ?? []) {
        if (
          n.nodeType === 1 &&
          (n.matches?.(".bulkbar") || n.querySelector?.(".bulkbar"))
        )
          stamp("bulkbar UNMOUNTED");
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-exiting"],
  });
  for (const type of ["animationstart", "animationend", "animationcancel"]) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target.classList?.contains("bulkbar"))
          stamp(`${type} ${e.animationName}`);
      },
      true,
    );
  }
  stamp(`observer armed (bulkbar present: ${!!document.querySelector(".bulkbar")})`);
};

async function state(page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".bulkbar");
    const boxes = [
      ...document.querySelectorAll(
        'input[type="checkbox"][aria-label^="Select sign"]',
      ),
    ];
    return {
      barPresent: !!bar,
      barExiting: bar ? bar.hasAttribute("data-exiting") : null,
      barText: bar ? bar.innerText.split("\n").slice(0, 2).join(" | ") : null,
      barOpacity: bar ? getComputedStyle(bar).opacity : null,
      checkedCount: boxes.filter((b) => b.checked).length,
      totalBoxes: boxes.length,
    };
  });
}

async function trial({ page, label, howToSelect, howToClear }) {
  console.log(`\n──────── ${label} ────────`);
  await page.goto(BASE + "/signs", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // let hydration settle
  await page.evaluate(OBSERVER);

  await howToSelect(page);
  await page.waitForTimeout(600); // let the bar settle (entrance anim is 200ms)
  const armed = await state(page);
  console.log("  after select :", JSON.stringify(armed));
  if (!armed.barPresent) {
    console.log("  !! bar never appeared — trial invalid");
    return null;
  }

  await howToClear(page);
  await page.waitForTimeout(4000); // #149 says it's visibly stuck at 4s+
  const after = await state(page);
  console.log("  after clear  :", JSON.stringify(after));

  const log = await page.evaluate(() => window.__bulkbarLog);
  console.log("  timeline:");
  for (const l of log) console.log("    " + l);

  console.log(
    `  VERDICT: ${after.barPresent ? "STUCK (reproduces #149)" : "dismissed OK"}`,
  );
  return after.barPresent;
}

async function main() {
  const userId = await ensureUser();
  const cookie = await mintCookie(userId);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.on("pageerror", (e) =>
    console.log(`  [pageerror] ${e.message.split("\n")[0]}`),
  );

  const selectAllReal = (p) =>
    p.getByRole("checkbox", { name: "Select all on this page" }).click();
  const selectOneReal = (p) =>
    p
      .locator('input[type="checkbox"][aria-label^="Select sign"]')
      .first()
      .click();
  const clearReal = (p) =>
    p.getByRole("button", { name: "clear", exact: true }).click();
  const clearSynthetic = (p) =>
    p.evaluate(() => {
      const btn = [...document.querySelectorAll(".bulkbar button")].find(
        (b) => b.textContent.trim() === "clear",
      );
      btn.click();
    });

  const results = {};
  results["A. select-all → clear (REAL click)"] = await trial({
    page,
    label: "A. select-all (real click) → clear (REAL click)",
    howToSelect: selectAllReal,
    howToClear: clearReal,
  });
  results["B. single row → clear (REAL click)"] = await trial({
    page,
    label: "B. single row (real click) → clear (REAL click)",
    howToSelect: selectOneReal,
    howToClear: clearReal,
  });
  results["C. select-all → clear (SYNTHETIC)"] = await trial({
    page,
    label: "C. select-all (real click) → clear (SYNTHETIC element.click())",
    howToSelect: selectAllReal,
    howToClear: clearSynthetic,
  });

  await browser.close();
  await removeUser();
  console.log("\n════════ SUMMARY ════════");
  let stuckAny = false;
  for (const [k, stuck] of Object.entries(results)) {
    console.log(`  ${stuck ? "FAIL (stuck)" : "PASS (dismissed)"}  ${k}`);
    if (stuck) stuckAny = true;
  }
  process.exit(stuckAny ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
