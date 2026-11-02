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
const enabled = (pg) => pg.waitForFunction(() => !document.querySelector("#nextTurn").disabled, null, { timeout: 2000 }).then(() => true).catch(() => false);
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
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
  check(await enabled(page), "covered call is a valid order");
  await page.screenshot({ path: OUT + "02-game-ticket.png", fullPage: true });
  await page.click("#nextTurn");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
  check(!(await page.isHidden("#turnToast")), "month summary toast shown");

  // Month 2: an invalid order (naked call write while flat) must be blocked.
  await page.click('.quick-btns button[data-x="0"]');
  await page.selectOption("#legSide", "W");
  await page.selectOption("#legType", "C");
  await page.click("#addLeg");
  check((await page.textContent("#nextTurn")) === "Fix the order to continue" && !(await page.isEnabled("#nextTurn")), "naked call write is rejected");
  check((await page.textContent("#errors")).includes("covered"), "error explains the covered-call rule");
  await page.locator("#legsList li button").first().click();
  // Short 50% and buy a protective 105 call.
  await page.locator("#stockSlider").fill("-50");
  await page.selectOption("#legSide", "B");
  await page.selectOption("#legType", "C");
  await page.selectOption("#legStrike", "105");
  await page.selectOption("#legSize", "0.5");
  await page.click("#addLeg");
  check(await enabled(page), "short + long call is valid");
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
  for (const id of ["tRank", "tSharpe", "tMdd", "tIrr", "tFinal"]) {
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

  // Head-to-head challenge: link -> friend plays the same blind tape -> side-by-side ranking.
  await page.fill("#challengeName", "Grant <b>");
  await page.click("#challengeBtn");
  const chUrl = await page.evaluate(() => navigator.clipboard.readText());
  check(chUrl.includes("#/challenge/"), "challenge link copied");
  const pc = await ctx.newPage();
  pc.on("pageerror", (e) => errors.push(String(e)));
  await pc.goto(chUrl);
  await pc.waitForSelector("#screen-game:not([hidden])");
  await pc.waitForSelector("#priceChart canvas");
  check((await pc.textContent("#h2hBanner")).includes("Grant b played this exact tape"), "challenge banner names the (sanitized) challenger");
  check((await pc.textContent("#priceTitle")) === "Mystery stock" && (await pc.textContent("#sTurn")).startsWith("1 of 12"), "friend starts the same blind tape at month 1");
  await pc.click(".autopilot summary");
  await pc.selectOption("#autoStrat", "trend200");
  await pc.click("#autoRun");
  await pc.waitForSelector("#h2hCard:not([hidden])");
  check((await pc.textContent("#revealTitle")) === title, "friend's game reveals the same stock");
  check((await pc.locator("#scoreTable tbody tr").count()) === 8, "scorecard ranks you, the challenger and 6 benchmarks");
  check(/win|Dead heat/.test(await pc.textContent("#h2hBody")), "head-to-head verdict shown");
  await pc.screenshot({ path: OUT + "12-challenge-results.png", fullPage: true });
  await pc.close();

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
  // Player's buy & hold must equal the buy & hold benchmark (ending value column).
  const youRow = await page.locator("#scoreTable tr.you td").nth(5).textContent();
  const bhRow = await page.locator("#scoreTable tr", { has: page.locator('td.name[title="Buy & hold the stock"]') }).locator("td").nth(5).textContent();
  check(youRow === bhRow, `autopilot buy & hold matches the benchmark (${youRow} vs ${bhRow})`);
  await page.screenshot({ path: OUT + "06-results-full.png", fullPage: true });

  // Review regressions --------------------------------------------------------
  // (1) Options can't bypass the leverage cap through the UI.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  await page.selectOption("#legSide", "B");
  await page.selectOption("#legType", "C");
  await page.selectOption("#legStrike", "90");
  await page.selectOption("#legSize", "2");
  await page.click("#addLeg");
  await page.click('.quick-btns button[data-x="100"]');
  check((await page.textContent("#nextTurn")) === "Fix the order to continue" && !(await page.isEnabled("#nextTurn")), "stock 100% + deep ITM calls on 200% is rejected");
  check((await page.textContent("#errors")).includes("Net long exposure"), "error explains the net-exposure cap");
  // (2) A 5th leg is refused with a message instead of silently dropping one.
  await page.locator("#legsList li button").first().click();
  for (let i = 0; i < 5; i++) {
    await page.selectOption("#legSize", "0.1");
    await page.click("#addLeg");
  }
  check((await page.locator("#legsList li").count()) === 4, "at most 4 legs kept");
  check((await page.textContent("#errors")).includes("at most 4"), "5th leg explained");
  // (3) Resume card after leaving a game.
  await page.click('.nav a[data-nav="how"]');
  await page.click('.nav a[data-nav="home"]');
  const resumeShown = await page.waitForSelector("#resumeCard:not([hidden])", { timeout: 2000 }).then(() => true).catch(() => false);
  check(resumeShown, "home shows a resume card for the game in progress");
  await page.click("#resumeBtn");
  await page.waitForSelector("#screen-game:not([hidden])");
  check(true, "resume returns to the game");
  // (4) Levered month then autopilot: never throws, always finishes.
  for (const strat of ["cash", "buyHold"]) {
    await page.goto(`http://127.0.0.1:${PORT}/#/`);
    await page.click("#startQuick");
    await page.waitForSelector("#priceChart canvas");
    await page.click('.quick-btns button[data-x="150"]');
    await page.click("#nextTurn");
    await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
    await page.waitForTimeout(400);
    check(await enabled(page), `keep-current is allowed after a 150% month (${strat})`);
    await page.click(".autopilot summary");
    await page.selectOption("#autoStrat", strat);
    await page.click("#autoRun");
    await page.waitForSelector("#screen-results:not([hidden])", { timeout: 10000 });
    const expCells = await page.locator("#logTable tbody tr td:nth-child(3)").allTextContents();
    const tail = expCells.slice(1);
    const want = strat === "cash" ? "0%" : "100%";
    check(tail.length === 11 && tail.every((t) => t === want || (strat === "buyHold" && t !== "")), `autopilot ${strat} after a levered month finishes (months 2-12: ${tail.slice(0, 3).join(",")}…)`);
  }
  // (5) A crafted replay link is rejected with a message.
  await page.goto(`http://127.0.0.1:${PORT}/#/replay/${Buffer.from(JSON.stringify({ c: { v: 1, sym: "VIX", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: -5, blind: true }, a: [] })).toString("base64url")}`);
  await page.waitForTimeout(800);
  check((await page.textContent("#staleBanner")).includes("isn't valid"), "invalid replay link is rejected");

  // Redesign checks ------------------------------------------------------------
  // (6) The next-month button names the action; Enter advances; a reload keeps the game.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  check((await page.textContent("#nextTurn")) === "Hold, go to month 2", "next-month button names a hold");
  await page.click('.quick-btns button[data-x="50"]');
  check((await page.textContent("#nextTurn")) === "Trade and go to month 2", "next-month button names a trade");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("Enter");
  const entered = await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"), null, { timeout: 2000 }).then(() => true).catch(() => false);
  check(entered, "Enter advances the month when nothing has focus");
  const titleBefore = await page.textContent("#priceTitle");
  await page.reload();
  await page.waitForSelector("#priceChart canvas");
  check((await page.textContent("#sTurn")).startsWith("2 of 12") && (await page.textContent("#priceTitle")) === titleBefore, "reload restores the game in progress");
  // (7) Results lead with a verdict in words; Play again keeps the mode and blind setting.
  await page.click(".autopilot summary");
  await page.selectOption("#autoStrat", "trend200");
  await page.click("#autoRun");
  await page.waitForSelector("#resEquityChart canvas");
  const verdict = await page.textContent("#verdict");
  check(/^(Tied )?\d+(st|nd|rd|th) of \d+/.test(verdict), `verdict in words: ${verdict}`);
  check(!(await page.textContent("#coachNotes")).includes("Versus the benchmarks") && (await page.textContent("#versusNote")).includes("Versus the benchmarks"), "benchmark note sits beside the verdict");
  await page.reload();
  await page.waitForSelector("#resEquityChart canvas");
  check((await page.textContent("#verdict")) === verdict, "reload restores the finished game's results");
  await page.click("#playAgain");
  await page.waitForSelector("#screen-game:not([hidden])");
  await page.waitForSelector("#priceChart canvas");
  const sameMode = (await page.textContent("#sTurn")).startsWith("1 of 12") && ((await page.textContent("#priceTitle")) === "Mystery stock") === (titleBefore === "Mystery stock");
  check(sameMode, "Play again starts the same mode and blind setting");

  // (8) The reveal ceremony (motion allowed here on purpose): final text from the first frame, skippable.
  const motion = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  const pmo = await motion.newPage();
  pmo.on("pageerror", (e) => errors.push(String(e)));
  pmo.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await pmo.goto(`http://127.0.0.1:${PORT}/`);
  await pmo.click("#startQuick");
  await pmo.waitForSelector("#priceChart canvas");
  await pmo.click(".autopilot summary");
  await pmo.click("#autoRun");
  // Read the title and press Skip in the same frame the ceremony is first seen, so a slow runner can't miss it.
  const during = await pmo.waitForFunction(() => {
    if (!document.querySelector("#screen-results").classList.contains("ceremony")) return false;
    const t = document.querySelector("#revealTitle").textContent;
    document.querySelector("#revealSkip").click();
    return t;
  }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => "");
  check(/^It was .+\(.+\)$/.test(during), "reveal title is final while the ceremony runs");
  check(!(await pmo.evaluate(() => document.querySelector("#screen-results").classList.contains("ceremony"))) && (await pmo.isHidden("#revealSkip")), "the ceremony can be skipped");
  await motion.close();

  // (9) Second review: keyboard focus, announcements, history and loading races.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click('.nav a[data-nav="how"]');
  await page.click('.nav a[data-nav="home"]');
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  await page.focus("#nextTurn");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
  await page.waitForTimeout(450);
  check(await page.evaluate(() => document.activeElement?.id === "nextTurn"), "keyboard focus stays on the next-month button after a month");
  await page.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
  const added = await page.waitForFunction(() => document.querySelector("#orderStatus").textContent.startsWith("Added: Buy 100%-strike calls"), null, { timeout: 2000 }).then(() => true).catch(() => false);
  check(added, "adding an option is announced");
  await page.locator("#legsList li button").first().click();
  await page.focus(".skip-link");
  await page.keyboard.press("Enter");
  check(!(await page.isHidden("#screen-game")) && (await page.evaluate(() => location.hash)) === "#/play", "skip link keeps the current screen");
  await page.click(".autopilot summary");
  await page.click("#autoRun");
  await page.waitForSelector("#resEquityChart canvas");
  check(await page.evaluate(() => document.activeElement?.id === "revealTitle"), "finishing moves focus to the results heading");
  await page.goBack();
  await page.waitForTimeout(300);
  check((await page.evaluate(() => location.hash)) !== "#/results" && (await page.isHidden("#screen-results")), "Back from the results leaves them");
  // A saved game is restored once even if the player navigates while its prices load.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  for (let i = 0; i < 3; i++) {
    await page.click('.quick-btns button[data-x="50"]');
    await page.click("#nextTurn");
    await page.waitForFunction((n) => document.querySelector("#sTurn").textContent.startsWith(`${n} of`), i + 2);
  }
  const savedBefore = await page.evaluate(() => localStorage.getItem("bt-save-v1"));
  await page.route("**/data/prices/*.json", async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); await r.continue(); });
  await page.reload();
  await page.waitForSelector("#homeData strong", { state: "attached" }); // the index is in; the stock's prices are still loading
  await page.click('.nav a[data-nav="how"]');
  await page.click('.nav a[data-nav="home"]');
  await page.waitForSelector("#resumeCard:not([hidden])", { timeout: 8000 });
  await page.unroute("**/data/prices/*.json");
  check((await page.textContent("#resumeText")).startsWith("Month 4 of 12") && (await page.evaluate(() => localStorage.getItem("bt-save-v1"))) === savedBefore, "navigating while a saved game loads restores it once");

  // (10) Space skips the reveal without scrolling the page.
  const motion2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  const pm2 = await motion2.newPage();
  pm2.on("pageerror", (e) => errors.push(String(e)));
  await pm2.goto(`http://127.0.0.1:${PORT}/`);
  await pm2.click("#startQuick");
  await pm2.waitForSelector("#priceChart canvas");
  await pm2.click(".autopilot summary");
  await pm2.click("#autoRun");
  await pm2.waitForFunction(() => document.querySelector("#screen-results").classList.contains("ceremony"), null, { timeout: 10000 });
  await pm2.keyboard.press(" ");
  await pm2.waitForTimeout(150);
  check(!(await pm2.evaluate(() => document.querySelector("#screen-results").classList.contains("ceremony"))) && (await pm2.evaluate(() => window.scrollY)) === 0, "Space skips the reveal without scrolling");
  await motion2.close();

  // (11) The scorecard fits at tablet and small-laptop widths.
  for (const w of [768, 1024]) {
    const tc = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: "reduce" });
    const tp = await tc.newPage();
    tp.on("pageerror", (e) => errors.push(String(e)));
    await tp.goto(url);
    await tp.waitForSelector("#resEquityChart canvas");
    const fits = await tp.evaluate(() => { const t = document.querySelector("#scoreTable"); return t.scrollWidth <= t.parentElement.clientWidth + 1; });
    check(fits, `scorecard fits without sideways scrolling at ${w}px`);
    await tc.close();
  }

  // (12) Third review: other tabs, history after Play again, cleared announcements, long challenger names.
  {
    const tabs = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const metaRes = await (await fetch(`http://127.0.0.1:${PORT}/data/meta.json`)).json();
    const older = new Date(Date.parse(metaRes.as_of + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
    // Tab A was opened before the daily refresh (older data) and sits on the home screen.
    const ta = await tabs.newPage();
    ta.on("pageerror", (e) => errors.push(String(e)));
    await ta.route("**/data/meta.json", async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, json: { ...(await res.json()), as_of: older } });
    });
    await ta.goto(`http://127.0.0.1:${PORT}/#/`);
    await ta.waitForSelector("#homeData strong");
    // Tab H, with no game of its own, reads How it works.
    const th = await tabs.newPage();
    th.on("pageerror", (e) => errors.push(String(e)));
    await th.goto(`http://127.0.0.1:${PORT}/#/how`);
    await th.waitForSelector("#homeData strong", { state: "attached" });
    // Tab B starts a game and plays a month.
    const tb = await tabs.newPage();
    tb.on("pageerror", (e) => errors.push(String(e)));
    await tb.goto(`http://127.0.0.1:${PORT}/#/`);
    await tb.click("#startQuick");
    await tb.waitForSelector("#priceChart canvas");
    await tb.click('.quick-btns button[data-x="100"]');
    await tb.click("#nextTurn");
    await tb.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
    await ta.waitForFunction(() => !document.querySelector("#tabNote").hidden, null, { timeout: 4000 }).catch(() => {});
    const kept = await tb.evaluate(() => JSON.parse(localStorage.getItem("bt-save-v1") || "null"));
    check(kept && (await ta.textContent("#tabNote")).includes("newer market data"), "a tab with older data leaves another tab's save alone and asks for a reload");
    await th.waitForTimeout(300);
    check(await th.isHidden("#tabNote"), "a tab with no game of its own doesn't say its game was changed");
    await tb.reload();
    await tb.waitForSelector("#priceChart canvas", { timeout: 5000 }).catch(() => {});
    check(!(await tb.isHidden("#screen-game")) && (await tb.textContent("#sTurn")).startsWith("2 of 12"), "the game survives the reload with an older tab open");
    await tabs.close();
  }
  // The order announcement is cleared with the order when the month is played.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  await page.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
  await page.waitForFunction(() => document.querySelector("#orderStatus").textContent.startsWith("Added:"), null, { timeout: 2000 }).catch(() => {});
  await page.click("#nextTurn");
  await page.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("2 of"));
  await page.waitForTimeout(100);
  check((await page.textContent("#orderStatus")) === "" && (await page.locator("#legsList li").count()) === 0, "the order announcement is cleared when the month is played");
  // Play again, finish the second game, and one Back leaves the results.
  await page.click(".autopilot summary");
  await page.click("#autoRun");
  await page.waitForSelector("#resEquityChart canvas");
  await page.fill("#challengeName", "Bartholomew Jonesy");
  await page.click("#challengeBtn");
  const longUrl = await page.evaluate(() => navigator.clipboard.readText());
  await page.click("#playAgain");
  await page.waitForSelector("#screen-game:not([hidden])");
  await page.waitForSelector("#priceChart canvas");
  await page.click(".autopilot summary");
  await page.click("#autoRun");
  await page.waitForSelector("#screen-results:not([hidden])");
  await page.goBack();
  await page.waitForTimeout(300);
  check((await page.evaluate(() => location.hash)) !== "#/results" && (await page.isHidden("#screen-results")), "after Play again, one Back leaves the second game's results");
  // A long challenger name wraps instead of pushing the Beta column out of view.
  for (const w of [1024, 1101]) {
    const lc = await browser.newContext({ viewport: { width: w, height: 800 }, reducedMotion: "reduce" });
    const lp = await lc.newPage();
    lp.on("pageerror", (e) => errors.push(String(e)));
    await lp.goto(longUrl);
    await lp.waitForSelector("#priceChart canvas");
    await lp.click(".autopilot summary");
    await lp.selectOption("#autoStrat", "buyHold");
    await lp.click("#autoRun");
    await lp.waitForSelector("#h2hCard:not([hidden])");
    const fits = await lp.evaluate(() => { const t = document.querySelector("#scoreTable"); return t.scrollWidth <= t.parentElement.clientWidth + 1; });
    check(fits, `scorecard with a long challenger name fits at ${w}px`);
    await lc.close();
  }
  // Back during the reveal, then Space on a home button starts a game.
  {
    const mc = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
    const mp = await mc.newPage();
    mp.on("pageerror", (e) => errors.push(String(e)));
    await mp.goto(`http://127.0.0.1:${PORT}/`);
    await mp.click("#startQuick");
    await mp.waitForSelector("#priceChart canvas");
    await mp.click(".autopilot summary");
    await mp.click("#autoRun");
    await mp.waitForFunction(() => document.querySelector("#screen-results").classList.contains("ceremony"), null, { timeout: 10000 });
    await mp.goBack();
    await mp.waitForSelector("#screen-home:not([hidden])");
    await mp.focus("#startQuick");
    await mp.keyboard.press(" ");
    await mp.waitForSelector("#screen-game:not([hidden])", { timeout: 4000 }).catch(() => {});
    check(!(await mp.isHidden("#screen-game")), "Space on a home button works after leaving the reveal");
    await mc.close();
  }

  // How it works + data pages.
  await page.goto(`http://127.0.0.1:${PORT}/#/data`);
  await page.waitForSelector("#dataTable tbody tr");
  check((await page.locator("#dataTable tbody tr").count()) >= 13, "data page lists every series");
  await page.screenshot({ path: OUT + "07-data.png", fullPage: true });
  await page.goto(`http://127.0.0.1:${PORT}/#/how`);
  await page.screenshot({ path: OUT + "08-how.png", fullPage: true });

  // Dark mode + mobile.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const pd = await dark.newPage();
  pd.on("pageerror", (e) => errors.push(String(e)));
  await pd.goto(url);
  await pd.waitForSelector("#resEquityChart canvas");
  await pd.screenshot({ path: OUT + "09-results-dark.png", fullPage: true });
  await dark.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const pm = await mobile.newPage();
  pm.on("pageerror", (e) => errors.push(String(e)));
  await pm.goto(`http://127.0.0.1:${PORT}/`);
  await pm.click("#startQuick");
  await pm.waitForSelector("#priceChart canvas");
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `no horizontal scroll on mobile (overflow ${overflow}px)`);
  const bar = await pm.evaluate(() => {
    const b = document.querySelector("#actionBar");
    const r = document.querySelector("#nextTurn").getBoundingClientRect();
    return { fits: b.scrollWidth <= b.clientWidth + 1 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, h: r.height };
  });
  check(bar.fits && bar.h >= 44, `mobile action bar fits with a 44px button (${bar.h}px)`);
  const small = await pm.evaluate(() => [...document.querySelectorAll(".quick-btns button, #quotesTable button.px, #addLeg")].filter((b) => b.getBoundingClientRect().height < 44).length);
  check(small === 0, `mobile touch targets are at least 44px tall (${small} smaller)`);
  await pm.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
  const tiny = await pm.evaluate(() => [...document.querySelectorAll(".brand, .nav a, #themeToggle, .legs li button, details.help > summary, .autopilot > summary")]
    .filter((b) => b.getClientRects().length && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44)).map((b) => b.id || b.className || b.textContent.trim()));
  check(tiny.length === 0 && (await pm.evaluate(() => document.querySelector("#stockSlider").getBoundingClientRect().height)) >= 44, `mobile header, help, leg and slider targets are at least 44px${tiny.length ? ": " + tiny.join(", ") : ""}`);
  // Chart legend rows toggle a line: the label cell is what takes the tap.
  const shortLegend = (pg, sel) => pg.evaluate((q) => [...document.querySelectorAll(q)].filter((c) => c.getClientRects().length && c.getBoundingClientRect().height < 44).map((c) => c.textContent.trim()), sel);
  const tinyLegend = await shortLegend(pm, "#priceChart .u-legend .u-series + .u-series > th, #equityChart .u-legend .u-series + .u-series > th");
  check(tinyLegend.length === 0, `mobile chart legend rows are at least 44px tall${tinyLegend.length ? ": " + tinyLegend.join(", ") : ""}`);
  const monthLines = await pm.evaluate(() => { const e = document.querySelector("#sTurn"); return Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)); });
  check(monthLines === 1, `mobile month counter stays on one line (${monthLines})`);
  const headerFits = await pm.evaluate(() => { const t = document.querySelector(".topbar"); return t.scrollWidth <= t.clientWidth + 1; });
  check(headerFits, "mobile header fits");
  await pm.click(".autopilot summary");
  const overflow2 = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow2 <= 1, `no horizontal scroll on mobile with autopilot open (overflow ${overflow2}px)`);
  await pm.screenshot({ path: OUT + "10-mobile-game.png", fullPage: true });
  await pm.click("#autoRun");
  await pm.waitForSelector("#resEquityChart canvas");
  const overflow3 = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow3 <= 1, `no horizontal scroll on mobile results (overflow ${overflow3}px)`);
  const tableFits = await pm.evaluate(() => { const w = document.querySelector("#scoreTable"); return w.scrollWidth <= w.parentElement.clientWidth + 1; });
  check(tableFits, "mobile scorecard fits without sideways scrolling");
  const tinyRes = await pm.evaluate(() => [...document.querySelectorAll("#scoreHelp > summary, details.block > summary, .results-actions button")]
    .filter((b) => b.getClientRects().length && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44)).map((b) => b.id || b.textContent.trim()));
  check(tinyRes.length === 0, `mobile results targets are at least 44px${tinyRes.length ? ": " + tinyRes.join(", ") : ""}`);
  const tinyResLegend = await shortLegend(pm, "#screen-results .u-legend .u-series + .u-series > th");
  check(tinyResLegend.length === 0, `mobile results legend rows are at least 44px tall${tinyResLegend.length ? ": " + tinyResLegend.join(", ") : ""}`);
  await pm.screenshot({ path: OUT + "11-mobile-results.png", fullPage: true });
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
