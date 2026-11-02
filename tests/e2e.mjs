// End-to-end browser test: serves site/ locally, plays games through the real UI with
// Playwright/Chromium, checks for console errors, and saves screenshots.
//   node tests/e2e.mjs            (screenshots -> tests/artifacts/)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = await import("playwright"));
}

const PORT = 8765;
const ROOT = new URL("../site/", import.meta.url).pathname;
const OUT = new URL("./artifacts/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const errors = [];
let failed = false;
const tally = { passed: 0, failed: 0, checks: [] };
const check = (cond, msg) => {
  tally.checks.push({ ok: !!cond, msg });
  if (!cond) {
    failed = true;
    tally.failed++;
    console.error("FAIL:", msg);
  } else {
    tally.passed++;
    console.log("ok:", msg);
  }
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "light" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#homeData strong");
  check((await page.textContent("#homeData")).includes("through"), "home shows data as-of date");
  await page.screenshot({ path: OUT + "01-home.png", fullPage: true });

  // Quick round, blind.
  await page.click("#startQuick");
  await page.waitForSelector("#screen-game:not([hidden])");
  await page.waitForSelector("#priceChart canvas");
  check((await page.textContent("#priceTitle")) === "Mystery stock", "blind mode hides the ticker");
  check((await page.textContent("#sTurn")).startsWith("1 of 12"), "quick round has 12 months");

  // Month 1: go long 100% and write covered calls by clicking the 105 call bid.
  await page.click('.quick-btns button[data-x="100"]');
  const rows = page.locator("#quotesTable tbody tr");
  check((await rows.count()) === 5, "five strikes quoted");
  await rows.nth(3).locator("button.px").nth(0).click(); // 105% call, bid -> write
  check((await page.locator("#legsList li").count()) === 1, "leg added from quote click");
  check(await page.isEnabled("#nextTurn"), "covered call is a valid order");
  await page.screenshot({ path: OUT + "02-game-ticket.png", fullPage: true });
  await page.click("#nextTurn");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
  check(!(await page.isHidden("#turnToast")), "month summary toast shown");

  // Month 2: an invalid order (naked call write while flat) must be blocked.
  await page.click('.quick-btns button[data-x="0"]');
  await page.selectOption("#legSide", "W");
  await page.selectOption("#legType", "C");
  await page.click("#addLeg");
  check(!(await page.isEnabled("#nextTurn")), "naked call write is rejected");
  check((await page.textContent("#errors")).includes("covered"), "error explains the covered-call rule");
  await page.locator("#legsList li button").first().click();
  // Short 50% and buy a protective 105 call.
  await page.locator("#stockSlider").fill("-50");
  await page.selectOption("#legSide", "B");
  await page.selectOption("#legType", "C");
  await page.selectOption("#legStrike", "105");
  await page.selectOption("#legSize", "0.5");
  await page.click("#addLeg");
  check(await page.isEnabled("#nextTurn"), "short + long call is valid");
  await page.click("#nextTurn");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("3 of"));

  // Month 3: keep, then autopilot the rest with the trend rule.
  await page.click("#nextTurn");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("4 of"));
  await page.screenshot({ path: OUT + "03-game-midway.png", fullPage: true });
  await page.click(".autopilot summary");
  await page.selectOption("#autoStrat", "trend200");
  await page.click("#autoRun");
  await page.waitForSelector("#screen-results:not([hidden])");
  await page.waitForSelector("#resEquityChart canvas");
  const title = await page.textContent("#revealTitle");
  check(/^It was .+\(.+\)$/.test(title), `ticker revealed: ${title}`);
  const nRows = await page.locator("#scoreTable tbody tr").count();
  check(nRows === 7, `scorecard has You + 6 benchmarks (${nRows})`);
  check((await page.locator("#logTable tbody tr").count()) === 12, "month log has 12 rows");
  check((await page.locator("#coachNotes .note").count()) >= 3, "coach notes rendered");
  for (const id of ["tSharpe", "tMdd", "tIrr", "tFinal"]) {
    const t = await page.textContent("#" + id);
    check(t && t !== "–" && !t.includes("NaN"), `tile ${id} = ${t}`);
  }
  await page.screenshot({ path: OUT + "04-results.png", fullPage: true });

  // Replay link round-trip.
  const sharpe = await page.textContent("#tSharpe");
  const final = await page.textContent("#tFinal");
  await page.click("#copyReplay");
  const url = await page.evaluate(() => navigator.clipboard.readText());
  check(url.includes("#/replay/") && !url.includes(title.match(/\((.+)\)/)[1]), "replay link copied and doesn't reveal the ticker");
  const page2 = await ctx.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  await page2.goto(url);
  await page2.waitForSelector("#screen-results:not([hidden])");
  await page2.waitForSelector("#resEquityChart canvas");
  check((await page2.textContent("#tSharpe")) === sharpe && (await page2.textContent("#tFinal")) === final, "replay reproduces the exact result");
  check((await page2.textContent("#revealEyebrow")) === "Replay", "replay is labeled");
  await page2.close();

  // Full challenge via autopilot (covered call), open mode with a chosen ticker.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click(".options-panel summary");
  await page.selectOption("#optTicker", "NVDA");
  check(!(await page.isChecked("#optBlind")), "choosing a ticker turns blind mode off");
  await page.click("#startFull");
  await page.waitForSelector("#priceChart canvas");
  check((await page.textContent("#priceTitle")).includes("NVDA"), "open mode shows the ticker");
  check((await page.textContent("#sTurn")).startsWith("1 of 60"), "full challenge has 60 months");
  await page.screenshot({ path: OUT + "05-game-open.png", fullPage: true });
  await page.click(".autopilot summary");
  await page.selectOption("#autoStrat", "buyHold");
  await page.click("#autoRun");
  await page.waitForSelector("#resEquityChart canvas");
  // Player's buy & hold must equal the buy & hold benchmark.
  const youRow = await page.locator("#scoreTable tr.you td").nth(1).textContent();
  const bhRow = await page.locator("#scoreTable tr", { hasText: "Buy & hold the stock" }).locator("td").nth(1).textContent();
  check(youRow === bhRow, `autopilot buy & hold matches the benchmark (${youRow} vs ${bhRow})`);
  await page.screenshot({ path: OUT + "06-results-full.png", fullPage: true });

  // How it works + data pages.
  await page.goto(`http://127.0.0.1:${PORT}/#/data`);
  await page.waitForSelector("#dataTable tbody tr");
  check((await page.locator("#dataTable tbody tr").count()) >= 13, "data page lists every series");
  await page.screenshot({ path: OUT + "07-data.png", fullPage: true });
  await page.goto(`http://127.0.0.1:${PORT}/#/how`);
  await page.screenshot({ path: OUT + "08-how.png", fullPage: true });

  // Dark mode + mobile.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark" });
  const pd = await dark.newPage();
  pd.on("pageerror", (e) => errors.push(String(e)));
  await pd.goto(url);
  await pd.waitForSelector("#resEquityChart canvas");
  await pd.screenshot({ path: OUT + "09-results-dark.png", fullPage: true });
  await dark.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pm = await mobile.newPage();
  pm.on("pageerror", (e) => errors.push(String(e)));
  await pm.goto(`http://127.0.0.1:${PORT}/`);
  await pm.click("#startQuick");
  await pm.waitForSelector("#priceChart canvas");
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `no horizontal scroll on mobile (overflow ${overflow}px)`);
  await pm.screenshot({ path: OUT + "10-mobile-game.png", fullPage: true });
  await mobile.close();

  check(errors.length === 0, `no console/page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + "e2e_summary.json", JSON.stringify(tally, null, 2));
}
process.exit(failed ? 1 : 0);
