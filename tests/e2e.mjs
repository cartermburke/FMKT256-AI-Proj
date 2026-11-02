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
// Starting a game over one in progress asks first (a confirm dialog). Every page here says yes,
// as a player continuing would; a page can set page.answer = false to say no to the next one.
const dialogs = [];
const newContext = browser.newContext.bind(browser);
browser.newContext = async (opts) => {
  const c = await newContext(opts);
  c.on("page", (p) => p.on("dialog", (d) => {
    dialogs.push(d.message());
    if (p.answer === false) { p.answer = undefined; d.dismiss(); } else d.accept();
  }));
  return c;
};
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
  check(!(await page.isHidden("#turnToast")) && (await page.textContent("#turnToast")).startsWith("Month 1:"), "month summary toast shown");

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
    // The note is said once: moving between screens doesn't rewrite (and so re-announce) it.
    await ta.evaluate(() => {
      window.__noteMuts = 0;
      new MutationObserver((l) => { window.__noteMuts += l.length; }).observe(document.querySelector("#tabNote"), { childList: true, characterData: true, subtree: true, attributes: true });
    });
    for (const h of ["#/how", "#/data", "#/", "#/how", "#/"]) {
      await ta.evaluate((x) => { location.hash = x; }, h);
      await ta.waitForTimeout(150);
    }
    check((await ta.evaluate(() => window.__noteMuts)) === 0 && (await ta.textContent("#tabNote")).includes("newer market data"), "the newer-data note is said once, not again on every screen");
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

  // (13) Fourth review: saves across tabs during a load, challenge links and history, repeated
  // announcements, long one-word names, the chart gap on tall screens.
  const saveOf = (pg) => pg.evaluate(() => {
    const o = JSON.parse(localStorage.getItem("bt-save-v1") || "null");
    if (!o) return null;
    const d = JSON.parse(atob(o.code.replace(/-/g, "+").replace(/_/g, "/")));
    return { tab: o.tab, sym: d.c.sym, n: d.a.length };
  });
  const playMonths = async (pg, n) => {
    for (let i = 0; i < n; i++) {
      const before = await pg.textContent("#sTurn");
      await pg.waitForFunction(() => !document.querySelector("#nextTurn").disabled && document.querySelector("#nextTurn").getAttribute("aria-disabled") !== "true");
      await pg.click("#nextTurn");
      await pg.waitForFunction((b) => document.querySelector("#sTurn").textContent !== b, before);
    }
  };
  const autopilot = async (pg, strat) => {
    await pg.click(".autopilot summary");
    if (strat) await pg.selectOption("#autoStrat", strat);
    await pg.click("#autoRun");
  };
  {
    // Play again while another tab saves during the load: the new game is this tab's, so it keeps saving.
    const tabs = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const ta = await tabs.newPage();
    ta.on("pageerror", (e) => errors.push(String(e)));
    await ta.goto(`http://127.0.0.1:${PORT}/#/`);
    await ta.click("#startQuick");
    await ta.waitForSelector("#priceChart canvas");
    await autopilot(ta);
    await ta.waitForSelector("#resEquityChart canvas");
    const first = (await saveOf(ta)).sym;
    const tb = await tabs.newPage();
    tb.on("pageerror", (e) => errors.push(String(e)));
    await tb.goto(`http://127.0.0.1:${PORT}/#/`);
    await tb.click("#startQuick");
    await tb.waitForSelector("#priceChart canvas");
    // Play again draws a stock tab A hasn't loaded, and its price file is slow to arrive.
    await ta.evaluate(async (skip) => {
      const { mulberry32, pick } = await import(new URL("engine/rng.js", location.href).href);
      const m = await (await fetch("data/meta.json")).json();
      const pool = (m.pool_info || m.pool.map((s) => ({ symbol: s }))).filter((p) => m.series[p.symbol.replace("^", "")]).map((p) => p.symbol);
      let seed = 1;
      while (skip.includes(pick(mulberry32(seed), pool))) seed++;
      const orig = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = (a) => { crypto.getRandomValues = orig; a[0] = seed; return a; };
    }, [first, "SPY", "^VIX", "^IRX"]);
    await ta.route("**/data/prices/*.json", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue(); });
    await ta.click("#playAgain");
    await ta.waitForTimeout(400);
    await tb.click('.quick-btns button[data-x="100"]');
    await playMonths(tb, 1);
    await ta.waitForFunction(() => !document.querySelector("#screen-game").hidden && document.querySelector("#sTurn").textContent.startsWith("1 of 12"), null, { timeout: 8000 });
    await ta.waitForTimeout(300);
    await ta.unroute("**/data/prices/*.json");
    await ta.click('.quick-btns button[data-x="100"]');
    await playMonths(ta, 2);
    const aNote = await ta.isHidden("#tabNote");
    const aSave = await saveOf(ta);
    await ta.reload();
    await ta.waitForSelector("#priceChart canvas", { timeout: 5000 }).catch(() => {});
    check(aNote && aSave.n === 2 && (await ta.textContent("#sTurn")).startsWith("3 of 12") && aSave.sym !== first,
      "a game started while another tab saves keeps saving, and comes back on reload");
    check(!(await tb.isHidden("#tabNote")), "the other tab is the one told its game was changed");
    await tabs.close();
  }
  {
    // A tab whose game was replaced elsewhere goes home while the saved game loads slowly;
    // the game screen still showing works until then.
    const tabs = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
    const own = [];
    const ta = await tabs.newPage();
    ta.on("pageerror", (e) => own.push(String(e)));
    await ta.goto(`http://127.0.0.1:${PORT}/#/`);
    await ta.waitForSelector('#optTicker option[value="KO"]', { state: "attached" }); // the list fills once the data loads
    await ta.evaluate(() => { const o = document.querySelector("#optTicker"); o.value = "KO"; o.dispatchEvent(new Event("change")); });
    await ta.click("#startQuick");
    await ta.waitForSelector("#priceChart canvas");
    await playMonths(ta, 1);
    const tb = await tabs.newPage();
    tb.on("pageerror", (e) => errors.push(String(e)));
    await tb.goto(`http://127.0.0.1:${PORT}/#/`);
    await tb.waitForSelector('#optTicker option[value="UBER"]', { state: "attached" }); // the list fills once the data loads
    await tb.evaluate(() => { const o = document.querySelector("#optTicker"); o.value = "UBER"; o.dispatchEvent(new Event("change")); });
    await tb.click("#startQuick");
    await tb.waitForSelector("#priceChart canvas");
    await playMonths(tb, 1);
    await ta.waitForFunction(() => !document.querySelector("#tabNote").hidden, null, { timeout: 4000 }).catch(() => {});
    await ta.route("**/data/prices/UBER.json", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue(); });
    await ta.click('.nav a[data-nav="home"]');
    await ta.waitForTimeout(300);
    await ta.click("#addLeg", { timeout: 1000 }).catch(() => {});
    const box = await ta.locator("#priceChart").boundingBox().catch(() => null);
    if (box) for (let i = 0; i < 4; i++) await ta.mouse.move(box.x + 100 + i * 60, box.y + box.height / 2);
    await ta.click("#nextTurn", { timeout: 1000 }).catch(() => {});
    await ta.waitForSelector("#resumeCard:not([hidden])", { timeout: 6000 }).catch(() => {});
    check(own.length === 0 && (await ta.textContent("#resumeText")).startsWith("Month 2 of 12"),
      `the game screen still works while another tab's game loads (${own.length} errors)`);
    for (const e of own) errors.push(e);
    await tabs.close();
  }
  {
    // A finished challenge's link opened again starts a new attempt; opened from a game, one Back leaves it.
    const cc = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
    const cp = await cc.newPage();
    cp.on("pageerror", (e) => errors.push(String(e)));
    await cp.goto(`http://127.0.0.1:${PORT}/#/`);
    await cp.waitForSelector("#homeData strong");
    await cp.evaluate((u) => { location.href = u; }, longUrl);
    await cp.waitForSelector("#priceChart canvas");
    await autopilot(cp);
    await cp.waitForSelector("#h2hCard:not([hidden])");
    await cp.evaluate((u) => { location.href = u; }, longUrl);
    await cp.waitForFunction(() => !document.querySelector("#screen-game").hidden, null, { timeout: 5000 }).catch(() => {});
    check(!(await cp.isHidden("#screen-game")) && (await cp.textContent("#sTurn")).startsWith("1 of 12") && (await cp.evaluate(() => location.hash)) === "#/play",
      "opening a finished challenge's link again starts a new attempt");
    await cp.goto(`http://127.0.0.1:${PORT}/#/`);
    await cp.click("#startQuick");
    await cp.waitForSelector("#priceChart canvas");
    await playMonths(cp, 1);
    await cp.evaluate((u) => { location.href = u; }, longUrl);
    await cp.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("1 of 12"), null, { timeout: 5000 });
    await cp.waitForTimeout(400);
    await cp.goBack();
    await cp.waitForTimeout(400);
    check(!(await cp.isHidden("#screen-home")), "a challenge opened from a game leaves in one Back");
    await cc.close();
  }
  // A second refused fifth leg is announced again.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  for (let i = 0; i < 5; i++) {
    await page.selectOption("#legSize", "0.1");
    await page.click("#addLeg");
  }
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.__said = [];
    const a = document.querySelector("#errorAlert");
    new MutationObserver(() => window.__said.push(a.textContent)).observe(a, { childList: true, characterData: true, subtree: true });
  });
  await page.click("#addLeg");
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__said)).some((t) => t.includes("at most 4")), "a fifth leg refused again is announced again");
  // A one-word 20-letter challenger name: the line key stays on the name's line, and every table fits.
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await page.click("#startQuick");
  await page.waitForSelector("#priceChart canvas");
  await autopilot(page);
  await page.waitForSelector("#resEquityChart canvas");
  await page.fill("#challengeName", "Maximiliansschwarzer");
  await page.click("#challengeBtn");
  const wordUrl = await page.evaluate(() => navigator.clipboard.readText());
  for (const vp of [{ width: 1024, height: 800 }, { width: 1101, height: 800 }, { width: 320, height: 700, mobile: true }, { width: 360, height: 760, mobile: true }]) {
    const wc = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ...(vp.mobile ? { isMobile: true, hasTouch: true } : {}), reducedMotion: "reduce" });
    const wp = await wc.newPage();
    wp.on("pageerror", (e) => errors.push(String(e)));
    await wp.goto(wordUrl);
    await wp.waitForSelector("#priceChart canvas");
    await autopilot(wp, "buyHold");
    await wp.waitForSelector("#h2hCard:not([hidden])");
    const m = await wp.evaluate(() => {
      const fit = (t) => t.scrollWidth <= t.parentElement.clientWidth + 1;
      const td = document.querySelector("#scoreTable tr.ch td.name");
      const walk = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
      const r = document.createRange();
      r.selectNodeContents(walk.nextNode());
      const line = r.getClientRects()[0];
      const k = td.querySelector(".key").getBoundingClientRect();
      const mid = k.top + k.height / 2;
      return { score: fit(document.querySelector("#scoreTable")), h2h: fit(document.querySelector("#h2hBody table")), keyOnLine: mid >= line.top - 1 && mid <= line.bottom + 1 };
    });
    if (vp.mobile) check(m.h2h, `head-to-head table with a long one-word name fits at ${vp.width}px`);
    else check(m.score && m.h2h && m.keyOnLine, `long one-word challenger name keeps its line key and fits at ${vp.width}px`);
    await wc.close();
  }
  // On phones a long one-word name wraps inside the word: the scorecard is no wider than with a
  // short name, so the judged metrics stay in view.
  {
    const code = wordUrl.split("#/challenge/")[1];
    const j = JSON.parse(Buffer.from(code, "base64url").toString());
    j.c.by = "Grant";
    const shortUrl = `${wordUrl.split("#/challenge/")[0]}#/challenge/${Buffer.from(JSON.stringify(j)).toString("base64url")}`;
    for (const w of [375, 390]) {
      const widths = [];
      for (const u of [wordUrl, shortUrl]) {
        const nc = await browser.newContext({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
        const np = await nc.newPage();
        np.on("pageerror", (e) => errors.push(String(e)));
        await np.goto(u);
        await np.waitForSelector("#priceChart canvas");
        await autopilot(np, "buyHold");
        await np.waitForSelector("#h2hCard:not([hidden])");
        widths.push(await np.evaluate(() => document.querySelector("#scoreTable").scrollWidth));
        await nc.close();
      }
      check(widths[0] <= widths[1] + 1, `a long one-word name doesn't widen the phone scorecard at ${w}px (${widths[0]} vs ${widths[1]})`);
    }
  }
  // On a tall screen, the two charts stay together however tall the ticket is.
  {
    const gc = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
    const gp = await gc.newPage();
    gp.on("pageerror", (e) => errors.push(String(e)));
    await gp.goto(`http://127.0.0.1:${PORT}/#/`);
    await gp.click("#startQuick");
    await gp.waitForSelector("#priceChart canvas");
    await gp.click('.quick-btns button[data-x="100"]');
    await playMonths(gp, 1);
    await gp.waitForSelector("#equityChart canvas");
    const gap = await gp.evaluate(() => document.querySelector(".panel-account").getBoundingClientRect().top - document.querySelector(".panel-price").getBoundingClientRect().bottom);
    check(gap <= 17, `the price and account charts sit together on a 1920x1080 screen (gap ${Math.round(gap)}px)`);
    await gc.close();
  }

  // (14) Readiness audit: what a first-time player, a phone, a keyboard and a bad network meet.
  // Each block below runs on its own: an exception fails that block's check, not the rest.
  const block = async (fn) => {
    try { await fn(); } catch (e) { check(false, `audit block threw: ${String(e.message || e).split("\n")[0]}`); }
  };
  const fresh = async (opts = {}) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", ...opts });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    return { c, p };
  };
  const linkOf = (cfg, a) => Buffer.from(JSON.stringify({ c: cfg, a })).toString("base64url");
  await block(async () => {
    // On a laptop screen the ticket scrolls on its own: a price click shows what it did, and a
    // blocked order says why beside the button, which never scrolls away.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    const inView = (sel) => p.evaluate((q) => {
      const el = document.querySelector(q);
      if (!el || !el.getClientRects().length) return false;
      const r = el.getBoundingClientRect();
      const t = document.querySelector(".ticket").getBoundingClientRect();
      const bar = document.querySelector("#actionBar").getBoundingClientRect();
      return r.top >= t.top - 1 && r.bottom <= Math.min(t.bottom, bar.top) + 1;
    }, sel);
    await p.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
    await p.waitForTimeout(150);
    check(await inView("#legsList li:last-child"), "at 1280x800 the option just added is in view");
    await p.locator("#legsList li button").first().click();
    await p.click('.quick-btns button[data-x="150"]');
    await p.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
    await p.waitForTimeout(150);
    const why = await p.evaluate(() => { const w = document.querySelector("#abWhy"); return w && w.getClientRects().length ? w.textContent : ""; });
    check(await inView("#errors") && why.length > 10 && (await p.textContent("#errors")).startsWith(why.slice(0, 20)), "at 1280x800 a blocked order shows why, in the ticket and beside the button");
    await c.close();
  });
  await block(async () => {
    // A link cut short gets one plain message, which goes away once the player moves on.
    const { c, p } = await fresh();
    const demo = linkOf({ v: 1, sym: "UBER", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 60, blind: true, seed: 1, mode: "full" }, []);
    await p.goto(`http://127.0.0.1:${PORT}/#/replay/${demo.slice(0, 31)}`);
    await p.waitForSelector("#screen-home:not([hidden])");
    const msg = await p.textContent("#staleBanner");
    check(msg.includes("incomplete or was changed") && !/JSON|atob|position/.test(msg), "a cut-off link gets a plain message, not a parser error");
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    check((await p.textContent("#staleBanner")) === "" && (await p.evaluate(() => document.querySelector("#staleBanner").getBoundingClientRect().height)) <= 1, "the error message goes away once a new game starts");
    // Only one game is kept, so starting another over a game in progress asks first.
    await playMonths(p, 1);
    await p.click(".brand");
    await p.waitForSelector("#resumeCard:not([hidden])");
    const before = dialogs.length;
    p.answer = false;
    await p.click("#startFull");
    await p.waitForTimeout(300);
    check(dialogs.length === before + 1 && (await p.textContent("#resumeText")).startsWith("Month 2 of 12") && !(await p.isHidden("#screen-home")), "starting a new game over one in progress asks, and No keeps it");
    p.answer = false;
    await p.goto(chUrl);
    await p.waitForSelector("#screen-home:not([hidden])");
    await p.waitForSelector("#resumeCard:not([hidden])");
    check(dialogs.length === before + 2 && (await p.textContent("#resumeText")).startsWith("Month 2 of 12"), "opening a challenge link over a game in progress asks, and No keeps it");
    await p.click("#startFull");
    await p.waitForFunction(() => document.querySelector("#sTurn").textContent.startsWith("1 of 60"));
    check(dialogs.length === before + 3, "Yes starts the new game");
    // A month's summary comes back after a reload.
    await playMonths(p, 1);
    const toast = await p.textContent("#turnToast");
    await p.reload();
    await p.waitForSelector("#priceChart canvas");
    check(toast.startsWith("Month 1:") && (await p.textContent("#turnToast")) === toast, "the last month's summary survives a reload");
    await c.close();
  });
  await block(async () => {
    // The month labels under a dated chart never repeat or skip a month.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/how`);
    const bad = await p.evaluate(async () => {
      const { monthTicks } = await import("./ui/ticks.js");
      const { dates } = await (await fetch("data/prices/UBER.json")).json();
      const meta = await (await fetch("data/meta.json")).json();
      let end = dates.length - 1;
      while (dates[end] > meta.as_of) end--;
      const ym = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
      const out = [];
      for (const [turns, starts] of [[60, [0]], [12, Array.from({ length: 49 }, (_, i) => i)]]) {
        for (const st of starts) {
          const s0 = end - 60 * 21 + st * 21;
          for (const incr of [1, 2, 3, 6, 12]) {
            const ms = monthTicks(dates, s0, 0, turns, incr, 21).map((x) => ym(dates[Math.round(s0 + x * 21)]));
            for (let i = 1; i < ms.length; i++) if (ms[i] - ms[i - 1] !== incr) out.push(`${turns}m start ${st} every ${incr}: ${ms[i - 1]}->${ms[i]}`);
            if (turns === 12 && incr <= 2 && ms.length < 12 / incr - 1) out.push(`${turns}m start ${st} every ${incr}: only ${ms.length}`);
          }
        }
      }
      return out;
    }).catch((e) => [String(e)]);
    check(bad.length === 0, `dated chart axes step one calendar month at a time${bad.length ? ": " + bad.slice(0, 3).join("; ") : ""}`);
    await c.close();
  });
  await block(async () => {
    // The verdict names a margin call as the reason; the coach writes minus signs and
    // drawdowns the way the tiles do.
    const { c, p } = await fresh();
    const cfg = { v: 1, sym: "INTC", end: "2026-10-30", fullTurns: 60, startTurn: 13, turns: 12, blind: true, seed: 1, mode: "quick" };
    await p.goto(`http://127.0.0.1:${PORT}/#/replay/${linkOf(cfg, [[0, ""], [-100, ""], ...Array(10).fill([null, ""])])}`);
    await p.waitForSelector("#resEquityChart canvas");
    check(/margin call in month \d+ sold your positions/.test(await p.textContent("#verdict")), "after a margin call the verdict says so");
    const coach = (await p.textContent("#coachNotes")) + (await p.textContent("#versusNote"));
    check(!/-[$\d]/.test(coach) && /max drawdown of −\d/.test(coach), "the coach uses true minus signs and signed drawdowns");
    check((await p.locator("#screen-results h1").count()) === 1 && (await p.locator("#versusNote h2").count()) === 1, "results headings run h1, then h2 (the note beside the verdict)");
    const coachHeads = await p.evaluate(() => [...document.querySelectorAll("#coachNotes .note-head > :last-child")].map((h) => `${h.tagName}:${h.textContent}`));
    check(coachHeads.length >= 3 && coachHeads.every((t) => /^H3:[A-Z]/.test(t)) && !(await p.textContent("#coachNotes")).includes("<"), `coach notes are titled with h3 headings (${coachHeads.join(", ")})`);
    // The legend toggles a line from the keyboard too.
    const name = p.locator("#resEquityChart .u-legend .u-series + .u-series > th").first();
    await name.focus();
    const was = await name.getAttribute("aria-pressed");
    await p.keyboard.press("Enter");
    check((await name.getAttribute("role")) === "button" && was === "true" && (await name.getAttribute("aria-pressed")) === "false" && (await p.locator("#resEquityChart .u-legend .u-series.u-off").count()) === 1, "a legend name hides its line from the keyboard");
    // Ctrl+click shows one line alone; every toggle then reports its own line's state.
    await p.locator("#resEquityChart .u-legend .u-series + .u-series > th").nth(2).click({ modifiers: ["Control"] });
    const legend = await p.evaluate(() => {
      const ths = [...document.querySelectorAll("#resEquityChart .u-legend tr.u-series > th[role=button]")];
      return { off: ths.filter((th) => th.parentElement.classList.contains("u-off")).length, wrong: ths.filter((th) => th.getAttribute("aria-pressed") !== String(!th.parentElement.classList.contains("u-off"))).length };
    });
    check(legend.off >= 2 && legend.wrong === 0, `after Ctrl+click every legend toggle reports its line's state (${legend.off} hidden, ${legend.wrong} wrong)`);
    await c.close();
  });
  await block(async () => {
    // An open game's challenge says "tape", not "blind tape"; the four-option limit is a note,
    // not an error, while the order is still valid.
    const { c, p } = await fresh();
    await c.grantPermissions(["clipboard-read", "clipboard-write"]);
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.waitForSelector('#optTicker option[value="KO"]', { state: "attached" }); // the list fills once the data loads
    await p.evaluate(() => { const o = document.querySelector("#optTicker"); o.value = "KO"; o.dispatchEvent(new Event("change")); });
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await p.selectOption("#legSize", "0.1");
    for (let i = 0; i < 5; i++) await p.click("#addLeg");
    check((await p.locator("#legsList li").count()) === 4 && (await p.getAttribute("#errors", "class")).includes("note-only") && (await p.isEnabled("#nextTurn")), "the four-option limit shows as a note beside a valid order");
    for (const l of await p.locator("#legsList li button").all()) await p.locator("#legsList li button").first().click();
    await autopilot(p, "buyHold");
    await p.waitForSelector("#resEquityChart canvas");
    await p.click("#challengeBtn");
    await p.waitForFunction(() => document.querySelector("#copyMsg").textContent !== "");
    const m = await p.textContent("#copyMsg");
    check(m.includes("same tape") && !m.includes("blind"), "an open game's challenge doesn't promise a blind tape");
    await c.close();
  });
  await block(async () => {
    // A phone whose clipboard is refused still fits the screen.
    const { c, p } = await fresh({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await autopilot(p, "buyHold");
    await p.waitForSelector("#resEquityChart canvas");
    await p.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("denied")); navigator.share = undefined; });
    await p.click("#challengeBtn");
    await p.waitForSelector("#copyMsg a");
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 1, `the copy-it-yourself link fits a 375px phone (overflow ${over}px)`);
    check(await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".rk")).fontSize)) >= 12, "rank chips are at least 12px on phones");
    await c.close();
  });
  await block(async () => {
    // No data: a plain message and a retry instead of an empty page; How it works still opens.
    const { c, p } = await fresh();
    await p.route("**/data/meta.json", (r) => r.fulfill({ status: 404, body: "" }));
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.waitForSelector("#bootRetry:not([hidden])");
    check((await p.textContent("#bootMsg")).includes("Couldn't load the market data") && (await p.textContent("#staleBanner")) === "", "no data: a plain message and a retry button, not an empty page");
    await p.click('.nav a[data-nav="how"]');
    await p.waitForSelector("#screen-how:not([hidden])", { timeout: 2000 }).catch(() => {});
    check(!(await p.isHidden("#screen-how")), "How it works opens without the data");
    await c.close();
  });
  await block(async () => {
    // While a game's prices load, the pressed card says so and a second press doesn't queue
    // another game; a saved game whose prices fail to load is mentioned, not silently dropped.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.waitForSelector("#homeData strong");
    await p.route("**/data/prices/*.json", async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); await r.continue(); });
    await p.click("#startQuick");
    const busy = await p.getAttribute("#startQuick", "aria-busy");
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await p.unroute("**/data/prices/*.json");
    await p.waitForTimeout(1500);
    check(busy === "true" && (await p.textContent("#sTurn")).startsWith("1 of 12") && !(await p.isHidden("#screen-game")), "a pressed card shows it is loading and a second press starts nothing more");
    await playMonths(p, 1);
    await p.route("**/data/prices/*.json", (r) => r.fulfill({ status: 404, body: "" }));
    await p.reload();
    await p.waitForSelector("#homeData strong");
    await p.waitForFunction(() => !document.querySelector("#tabNote").hidden, null, { timeout: 4000 }).catch(() => {});
    check((await p.textContent("#tabNote")).includes("Couldn't load the prices for your saved game"), "a saved game that can't load is mentioned, not silently dropped");
    // A save dated after the loaded data doesn't blame another tab.
    await p.unroute("**/data/prices/*.json");
    await p.evaluate((code) => localStorage.setItem("bt-save-v1", JSON.stringify({ code, challenge: null, tab: "x" })), linkOf({ v: 1, sym: "KO", end: "2099-01-01", fullTurns: 60, startTurn: 0, turns: 12, blind: true, seed: 1, mode: "quick" }, [[0, ""]]));
    await p.reload();
    await p.waitForFunction(() => !document.querySelector("#tabNote").hidden, null, { timeout: 4000 }).catch(() => {});
    const note = await p.textContent("#tabNote");
    check(note.includes("newer market data") && !note.includes("another tab"), "a save from newer data asks for a reload without blaming another tab");
    await c.close();
  });
  await block(async () => {
    // Structure for screen readers and layout around the fixed action bar.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    const s14 = await p.evaluate(() => ({
      h1: document.querySelectorAll("#screen-game h1").length,
      names: [...document.querySelectorAll("#screen-game section[aria-label], #screen-game section[aria-labelledby]")].map((e) => e.getAttribute("aria-label") || document.getElementById(e.getAttribute("aria-labelledby"))?.textContent),
      toast: getComputedStyle(document.querySelector("#turnToast")).display !== "none" && !document.querySelector("#turnToast").hidden,
    }));
    check(s14.h1 === 1 && new Set(s14.names).size === s14.names.length, `the game screen has one h1 and distinct region names (${s14.names.join(", ")})`);
    check(s14.toast, "the month summary region is rendered before its first message");
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForTimeout(100);
    const footerSeen = await p.evaluate(() => {
      const s = document.querySelector(".footer span:last-child").getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + 5, s.top + s.height / 2);
      return !!hit && hit.closest(".footer") !== null;
    });
    check(footerSeen, "the footer disclaimer can be scrolled clear of the action bar");
    await c.close();
    const z = await fresh({ viewport: { width: 640, height: 400 } });
    await z.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await z.p.waitForSelector("#homeData strong");
    check(await z.p.evaluate(() => getComputedStyle(document.querySelector(".topbar")).position) === "static", "on a short (zoomed) screen the top bar scrolls away");
    await z.c.close();
    const t = await fresh({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    await t.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await t.p.click("#startQuick");
    await t.p.waitForSelector("#priceChart canvas");
    const smallT = await t.p.evaluate(() => [...document.querySelectorAll(".quick-btns button, #quotesTable button.px, .theme-toggle, select")].filter((b) => b.getClientRects().length && b.getBoundingClientRect().height < 44).length);
    check(smallT === 0, `tablet touch targets are at least 44px tall (${smallT} smaller)`);
    await t.c.close();
    const f = await fresh({ forcedColors: "active" });
    await f.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await f.p.click("#startQuick");
    await f.p.waitForSelector("#priceChart canvas");
    await f.p.click('.quick-btns button[data-x="100"]');
    const bgs = await f.p.evaluate(() => ["100", "50"].map((x) => getComputedStyle(document.querySelector(`.quick-btns button[data-x="${x}"]`)).backgroundColor));
    check(bgs[0] !== bgs[1], "in forced colors the chosen stock position stands out");
    await f.c.close();
  });
  await block(async () => {
    // Home: the pool is counted honestly and the sample tape is real (the S&P 500 ETF).
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.waitForSelector("#tapeDemo.ready", { timeout: 4000 }).catch(() => {});
    check((await p.textContent("#homeData")).startsWith("10 stocks and the S&P 500"), "home counts 10 stocks and the S&P 500");
    check((await p.textContent("#tapeName")) === "S&P 500 ETF (SPY)" && /^M0\.0 [\d.]+( L[\d.]+ [\d.]+){6,}$/.test(await p.getAttribute("#tapeDemo path", "d")), "the home page's sample tape is drawn from real prices");
    // The S&P 500 is in the blind pool, so the sample ends three months before the earliest day
    // any game's chart shows (a year before the game window): it can't give a blind game away.
    const tape = await p.evaluate(async () => {
      const meta = await (await fetch("data/meta.json")).json();
      const spy = await (await fetch("data/prices/SPY.json")).json();
      let last = spy.dates.length - 1;
      while (spy.dates[last] > meta.as_of) last--;
      const mon = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      return { label: document.querySelector("#tapeMeta").textContent, win: mon(spy.dates[last - (meta.game_years || 5) * 12 * 21 - 252 - 63]) };
    });
    check(/^[A-Z][a-z]{2} \d{4} to [A-Z][a-z]{2} \d{4}$/.test(tape.label) && tape.label.endsWith(` to ${tape.win}`), `the sample tape ends three months before the earliest game chart (${tape.label}; to ${tape.win})`);
    const tieRule = /equal averages go to the higher Sharpe( ratio)?, then the higher IRR/i;
    check(tieRule.test(await p.textContent("#scoreHelp")) && tieRule.test(await p.textContent("#screen-how")), "the scorecard help and How it works say how equal average ranks are ordered");
    await p.goto(`http://127.0.0.1:${PORT}/#/how`);
    check((await p.textContent("#how-limits + ul")).includes("can be decoded"), "the limits say a shared link can be decoded");
    await c.close();
  });

  await block(async () => {
    // A damaged challenge link replaces nothing, so it asks nothing; a damaged link that opens a
    // tab still offers the saved game; No to a challenge goes back to where the player was.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await playMonths(p, 1);
    await p.click(".brand");
    await p.waitForSelector("#resumeCard:not([hidden])");
    const before = dialogs.length;
    await p.goto(chUrl.slice(0, chUrl.indexOf("#/challenge/") + 12 + 31));
    await p.waitForFunction(() => document.querySelector("#staleBanner").textContent.includes("incomplete or was changed"), null, { timeout: 4000 }).catch(() => {});
    check(dialogs.length === before && (await p.textContent("#staleBanner")).includes("incomplete or was changed") && (await p.textContent("#resumeText")).startsWith("Month 2 of 12"), "a damaged challenge link over a game in progress asks nothing and keeps the game");
    const p2 = await c.newPage();
    p2.on("pageerror", (e) => errors.push(String(e)));
    await p2.goto(`http://127.0.0.1:${PORT}/#/replay/${linkOf({ v: 1, sym: "UBER", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 60, blind: true, seed: 1, mode: "full" }, []).slice(0, 31)}`);
    await p2.waitForSelector("#screen-home:not([hidden])");
    await p2.waitForSelector("#resumeCard:not([hidden])", { timeout: 4000 }).catch(() => {});
    check((await p2.textContent("#staleBanner")).includes("incomplete or was changed") && !(await p2.isHidden("#resumeCard")) && (await p2.textContent("#resumeText")).startsWith("Month 2 of 12"), "a damaged link that opens a tab still offers the saved game");
    await p2.close();
    await p.goto(`http://127.0.0.1:${PORT}/#/how`);
    await p.waitForSelector("#screen-how:not([hidden])");
    p.answer = false;
    await p.goto(chUrl);
    await p.waitForFunction(() => location.hash === "#/how" && !document.querySelector("#screen-how").hidden, null, { timeout: 4000 }).catch(() => {});
    check(dialogs.length === before + 1 && (await p.evaluate(() => location.hash)) === "#/how" && !(await p.isHidden("#screen-how")), "No to a challenge opened from How it works goes back there");
    await c.close();
  });
  await block(async () => {
    // No to a challenge on the entry a tab opened on goes home, never out of the app; No to a
    // link pasted while the data loads goes back to the page; a damaged link over a replay
    // still offers the saved game.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await playMonths(p, 1);
    const p2 = await c.newPage();
    p2.on("pageerror", (e) => errors.push(String(e)));
    const partial = linkOf({ v: 1, sym: "KO", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 12, blind: true, seed: 1, mode: "quick", by: "Pat" }, [[100, ""]]);
    await p2.goto(`http://127.0.0.1:${PORT}/#/challenge/${partial}`);
    await p2.waitForFunction(() => document.querySelector("#staleBanner").textContent.includes("incomplete"), null, { timeout: 5000 }).catch(() => {});
    await p2.click('.nav a[data-nav="how"]');
    await p2.waitForSelector("#screen-how:not([hidden])");
    p2.answer = false;
    await p2.goBack();
    await p2.waitForTimeout(800);
    const where = await p2.evaluate(() => ({ url: location.href, home: !document.querySelector("#screen-home")?.hidden }));
    check(where.url.endsWith("#/") && where.home, `No to a challenge on the entry a tab opened on goes home (${where.url.slice(-24)})`);
    await p2.close();
    const p3 = await c.newPage();
    p3.on("pageerror", (e) => errors.push(String(e)));
    let release;
    const gate = new Promise((ok) => { release = ok; });
    await p3.route("**/data/meta.json", async (r) => { await gate; await r.continue(); });
    await p3.goto(`http://127.0.0.1:${PORT}/#/how`);
    await p3.waitForSelector("#screen-how:not([hidden])");
    p3.answer = false;
    await p3.goto(chUrl);
    release();
    await p3.waitForFunction(() => location.hash === "#/how" && !document.querySelector("#screen-how").hidden, null, { timeout: 5000 }).catch(() => {});
    check((await p3.evaluate(() => location.hash)) === "#/how" && !(await p3.isHidden("#screen-how")), "No to a challenge pasted while the data loads goes back to the page");
    await p3.close();
    const cfg = { v: 1, sym: "KO", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 12, blind: false, seed: 1, mode: "quick" };
    await p.goto(`http://127.0.0.1:${PORT}/#/replay/${linkOf(cfg, Array(12).fill([100, ""]))}`);
    await p.waitForSelector("#resEquityChart canvas");
    await p.goto(`http://127.0.0.1:${PORT}/#/replay/${linkOf(cfg, []).slice(0, 31)}`);
    await p.waitForSelector("#screen-home:not([hidden])");
    await p.waitForSelector("#resumeCard:not([hidden])", { timeout: 4000 }).catch(() => {});
    check(!(await p.isHidden("#resumeCard")) && (await p.textContent("#resumeText")).startsWith("Month 2 of 12"), "a damaged link opened over a replay still offers the saved game");
    await c.close();
  });
  await block(async () => {
    // A tab opened on a challenge whose prices failed, then a game, then Back: the challenge
    // opens there and the tab stays in the app. A blind game's error never names its stock.
    const { c, p } = await fresh();
    const full = linkOf({ v: 1, sym: "KO", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 12, blind: true, seed: 1, mode: "quick", by: "Pat" }, Array(12).fill([100, ""]));
    let failed = 0;
    await p.route("**/data/prices/KO.json", (r) => (failed++ ? r.continue() : r.fulfill({ status: 503, body: "" })));
    await p.goto(`http://127.0.0.1:${PORT}/#/challenge/${full}`);
    await p.waitForSelector("#screen-home:not([hidden])");
    await p.waitForFunction(() => document.querySelector("#staleBanner").textContent.length > 0, null, { timeout: 4000 }).catch(() => {});
    const banner = await p.textContent("#staleBanner");
    check(banner.includes("Couldn't load the prices for this game") && !/KO|Coca/.test(banner), `a blind game's load error doesn't name the stock (${banner.slice(0, 60)})`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await p.goBack();
    await p.waitForTimeout(1500);
    const at = await p.evaluate(() => ({ url: location.href, game: !document.querySelector("#screen-game")?.hidden }));
    check(at.url.endsWith("#/play") && at.game, `Back from a game onto the challenge the tab opened on stays in the app (${at.url.slice(-20)})`);
    await c.close();
    // Back onto a challenge that failed after Yes, then No: home shows in place, and Forward
    // returns to the game with no more questions.
    const f = await fresh();
    await f.p.goto(`http://127.0.0.1:${PORT}/#/`);
    // Not KO: a random draw of KO would load (and cache) its prices, so the failure never happens.
    await f.p.click(".options-panel summary");
    await f.p.selectOption("#optTicker", "NVDA");
    await f.p.click("#startQuick");
    await f.p.waitForSelector("#priceChart canvas");
    await playMonths(f.p, 1);
    await f.p.click(".brand");
    await f.p.waitForSelector("#resumeCard:not([hidden])");
    let once = 0;
    await f.p.route("**/data/prices/KO.json", (r) => (once++ ? r.continue() : r.fulfill({ status: 503, body: "" })));
    await f.p.goto(`http://127.0.0.1:${PORT}/#/challenge/${full}`);
    await f.p.waitForFunction(() => document.querySelector("#staleBanner").textContent.length > 0, null, { timeout: 4000 }).catch(() => {});
    await f.p.click("#resumeBtn");
    await f.p.waitForSelector("#screen-game:not([hidden])");
    const before = dialogs.length;
    f.p.answer = false;
    await f.p.goBack();
    await f.p.waitForTimeout(800);
    const back = await f.p.evaluate(() => location.hash);
    await f.p.goForward();
    await f.p.waitForTimeout(800);
    const fwd = await f.p.evaluate(() => ({ hash: location.hash, turn: document.querySelector("#sTurn")?.textContent || "", game: !document.querySelector("#screen-game").hidden }));
    check(back === "#/" && fwd.hash === "#/play" && fwd.game && fwd.turn.startsWith("2 of 12") && dialogs.length === before + 1, `No on a challenge reached by Back shows home, and Forward returns to the game (${back} -> ${fwd.hash} ${fwd.turn}, ${dialogs.length - before} question)`);
    await f.c.close();
  });
  await block(async () => {
    // Yes on a failed challenge reached by Back from the game opens that challenge's game (the
    // entry behind it isn't this game's #/play, so no step back onto it).
    const slowly = (pg, sym, ms) => pg.route(`**/data/prices/${sym}.json`, async (r) => { await new Promise((z) => setTimeout(z, ms)); r.continue(); });
    const ko = linkOf({ v: 1, sym: "KO", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 12, blind: true, seed: 1, mode: "quick", by: "Pat" }, Array(12).fill([100, ""]));
    const xom = linkOf({ v: 1, sym: "XOM", end: "2026-10-30", fullTurns: 60, startTurn: 3, turns: 12, blind: false, seed: 2, mode: "quick", by: "Sam" }, Array(12).fill([100, ""]));
    const savedChallenge = (pg) => pg.evaluate(() => { try { return JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k !== "bt-theme"))).challenge; } catch { return null; } });
    const g = await fresh();
    await g.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await g.p.click(".options-panel summary");
    await g.p.selectOption("#optTicker", "NVDA");
    await g.p.click("#startQuick");
    await g.p.waitForSelector("#priceChart canvas");
    await playMonths(g.p, 1);
    await g.p.click(".brand");
    await g.p.waitForSelector("#resumeCard:not([hidden])");
    let once = 0;
    await g.p.route("**/data/prices/KO.json", (r) => (once++ ? r.continue() : r.fulfill({ status: 503, body: "" })));
    await g.p.goto(`http://127.0.0.1:${PORT}/#/challenge/${ko}`);
    await g.p.waitForFunction(() => document.querySelector("#staleBanner").textContent.length > 0, null, { timeout: 4000 }).catch(() => {});
    await g.p.click("#resumeBtn");
    await g.p.waitForSelector("#screen-game:not([hidden])");
    await g.p.goBack();
    await g.p.waitForTimeout(1500);
    const yes = await g.p.evaluate(() => ({ hash: location.hash, game: !document.querySelector("#screen-game").hidden, turn: document.querySelector("#sTurn").textContent }));
    check(yes.hash === "#/play" && yes.game && yes.turn.startsWith("1 of 12") && (await savedChallenge(g.p)) === ko, `Yes on a failed challenge reached by Back opens its game (${yes.hash}, ${yes.game ? "game" : "not the game"} ${yes.turn})`);
    await g.c.close();
    // A second challenge link pasted while the first still loads opens, and stays open: the
    // first link's entry behind it isn't routed again.
    const h = await fresh();
    await h.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await h.p.click(".options-panel summary");
    await h.p.selectOption("#optTicker", "NVDA");
    await h.p.click("#startQuick");
    await h.p.waitForSelector("#priceChart canvas");
    await playMonths(h.p, 1);
    await slowly(h.p, "KO", 1500);
    await h.p.evaluate((x) => { location.hash = x; }, `#/challenge/${ko}`);
    await h.p.waitForTimeout(300);
    await h.p.evaluate((x) => { location.hash = x; }, `#/challenge/${xom}`);
    await h.p.waitForTimeout(3500);
    const last = await h.p.evaluate(() => ({ hash: location.hash, title: document.querySelector("#priceTitle").textContent }));
    check(last.hash === "#/play" && last.title.includes("XOM") && (await savedChallenge(h.p)) === xom, `the last challenge link pasted while another loads is the one that opens (${last.title})`);
    await h.c.close();
    // Two challenge links pasted while a replay loads: each is asked about once.
    const r = await fresh();
    await r.p.goto(`http://127.0.0.1:${PORT}/#/`);
    await r.p.click(".options-panel summary");
    await r.p.selectOption("#optTicker", "NVDA");
    await r.p.click("#startQuick");
    await r.p.waitForSelector("#priceChart canvas");
    await playMonths(r.p, 1);
    await slowly(r.p, "TSLA", 2000);
    const rep = linkOf({ v: 1, sym: "TSLA", end: "2026-10-30", fullTurns: 60, startTurn: 2, turns: 12, blind: false, seed: 4, mode: "quick" }, Array(12).fill([100, ""]));
    const asked = dialogs.length;
    await r.p.evaluate((x) => { location.hash = x; }, `#/replay/${rep}`);
    await r.p.waitForTimeout(300);
    // Every question here is answered No (page.answer otherwise covers one question only).
    Object.defineProperty(r.p, "answer", { get: () => false, set: () => {} });
    await r.p.evaluate((x) => { location.hash = x; }, `#/challenge/${xom}`);
    await r.p.waitForTimeout(100);
    await r.p.evaluate((x) => { location.hash = x; }, `#/challenge/${ko}`);
    await r.p.waitForTimeout(4500);
    check(dialogs.length - asked === 2, `two challenge links pasted while a replay loads are asked about once each (${dialogs.length - asked} questions)`);
    await r.c.close();
  });
  await block(async () => {
    // Once another tab has saved over this one's game, the game at stake is the saved one.
    const { c, p: ta } = await fresh();
    await ta.goto(`http://127.0.0.1:${PORT}/#/`);
    await ta.click("#startQuick");
    await ta.waitForSelector("#priceChart canvas");
    const tb = await c.newPage();
    tb.on("pageerror", (e) => errors.push(String(e)));
    await tb.goto(`http://127.0.0.1:${PORT}/#/`);
    await tb.waitForSelector("#homeData strong");
    await tb.click("#startQuick");
    await tb.waitForSelector("#priceChart canvas");
    await playMonths(tb, 2);
    await ta.waitForFunction(() => !document.querySelector("#tabNote").hidden, null, { timeout: 4000 }).catch(() => {});
    const before = dialogs.length;
    ta.answer = false;
    await ta.goto(chUrl);
    await ta.waitForTimeout(500);
    check(dialogs.length === before + 1 && dialogs[dialogs.length - 1].includes("(month 3 of 12)"), "opening a challenge in a tab another tab has saved over asks about that tab's game");
    await c.close();
  });
  await block(async () => {
    // While the data loads: How it works keeps the reader's place when the data arrives, and
    // the nav marks the page that is loading.
    const { c, p } = await fresh();
    let release;
    const gate = new Promise((ok) => { release = ok; });
    await p.route("**/data/meta.json", async (r) => { await gate; await r.continue(); });
    await p.goto(`http://127.0.0.1:${PORT}/#/how`);
    await p.waitForSelector("#screen-how:not([hidden])");
    await p.evaluate(() => window.scrollTo(0, 1500));
    const y0 = await p.evaluate(() => window.scrollY);
    await p.click('.nav a[data-nav="data"]');
    await p.waitForSelector("#boot:not([hidden])");
    const cur = await p.evaluate(() => [...document.querySelectorAll('.nav a[aria-current="page"]')].map((a) => a.dataset.nav).join());
    check(cur === "data", `while the data loads, the nav marks the page being opened (${cur})`);
    await p.goBack();
    await p.waitForSelector("#screen-how:not([hidden])");
    await p.evaluate(() => window.scrollTo(0, 1500));
    release();
    await p.waitForSelector("#homeData strong", { state: "attached" });
    await p.waitForTimeout(300);
    const y1 = await p.evaluate(() => window.scrollY);
    check(y0 > 1000 && y1 > 1000, `How it works keeps the reader's place when the data arrives (${y0} -> ${y1})`);
    await c.close();
  });
  await block(async () => {
    // Tablets: the brand link and the results legend toggles are 44px touch targets too.
    const { c, p } = await fresh({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const cfg = { v: 1, sym: "KO", end: "2026-10-30", fullTurns: 60, startTurn: 0, turns: 12, blind: false, seed: 1, mode: "quick" };
    await p.goto(`http://127.0.0.1:${PORT}/#/replay/${linkOf(cfg, Array(12).fill([100, ""]))}`);
    await p.waitForSelector("#resEquityChart canvas");
    const small = await p.evaluate(() => [...document.querySelectorAll(".brand, #screen-results .u-legend th[role=button]")].filter((b) => b.getClientRects().length && b.getBoundingClientRect().height < 44).map((b) => `${b.textContent.trim()} ${Math.round(b.getBoundingClientRect().height)}px`));
    check(small.length === 0, `on tablets the brand and legend toggles are at least 44px tall${small.length ? ": " + small.join(", ") : ""}`);
    await c.close();
  });
  await block(async () => {
    // On a 320px phone a blocked order adds a reason line to the action bar; the footer still
    // clears it.
    const { c, p } = await fresh({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    await p.goto(`http://127.0.0.1:${PORT}/#/`);
    await p.click("#startQuick");
    await p.waitForSelector("#priceChart canvas");
    await playMonths(p, 1);
    await p.click('.quick-btns button[data-x="150"]');
    await p.locator("#quotesTable tr.atm button.px[data-side='B'][data-type='C']").click();
    await p.waitForFunction(() => document.querySelector("#abWhy").textContent.length > 10, null, { timeout: 4000 }).catch(() => {});
    await p.waitForTimeout(300); // the page grows with the bar; then scroll to its end
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForTimeout(200);
    const seen = await p.evaluate(() => {
      const s = document.querySelector(".footer span:last-child").getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + 5, s.bottom - 3);
      return { why: document.querySelector("#abWhy").textContent.length > 10, ok: !!hit && hit.closest(".footer") !== null, bar: Math.round(document.querySelector("#actionBar").getBoundingClientRect().height) };
    });
    check(seen.why && seen.ok, `at 320px with a blocked order the footer clears the ${seen.bar}px action bar`);
    await c.close();
  });

  await block(async () => {
    // How it works reads in layers: summaries first with the detail folded (Quick tour), or
    // everything open (Full detail); Explain terms adds short definitions; both are remembered.
    // The numbers strip is built from the rules and the live data index.
    const { c, p } = await fresh();
    await p.goto(`http://127.0.0.1:${PORT}/#/how`);
    await p.waitForSelector("#screen-how:not([hidden])");
    await p.waitForFunction(() => /\d{4}/.test(document.querySelector("#howNumbers").textContent), null, { timeout: 4000 }).catch(() => {});
    const view = () => p.evaluate(() => {
      const folds = [...document.querySelectorAll("#screen-how details.how-more")];
      const defs = [...document.querySelectorAll("#screen-how .term-def")];
      return {
        topics: document.querySelectorAll("#screen-how .how-topic").length,
        shorts: [...document.querySelectorAll("#screen-how .how-topic > h2 + .how-short, #screen-how .how-topic > h2 + .how-short-list")].filter((e) => e.getClientRects().length).length,
        open: folds.filter((d) => d.open).length, folds: folds.length,
        defsShown: defs.filter((d) => d.getClientRects().length).length, defs: defs.length,
        quick: document.querySelector('[data-how-depth="quick"]').getAttribute("aria-pressed"),
        terms: document.querySelector("#howTerms").getAttribute("aria-pressed"),
        facts: document.querySelectorAll("#screen-how .how-fact").length,
        numbers: document.querySelector("#howNumbers").textContent,
        words: document.querySelector("#screen-how").innerText.split(/\s+/).filter(Boolean).length,
      };
    });
    const q = await view();
    const asOf = await p.evaluate(async () => (await (await fetch("data/meta.json")).json()).as_of);
    const asOfText = new Date(`${asOf}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    check(q.topics === 8 && q.shorts === 8 && q.folds >= 8 && q.open === 0 && q.defsShown === 0 && q.quick === "true" && q.terms === "false", `How it works opens as a quick tour: 8 summaries, every fold closed, no definitions (${q.open}/${q.folds} open, ${q.words} words)`);
    check(q.numbers.includes("$100,000") && q.numbers.includes("60 months") && q.numbers.includes(asOfText) && q.facts >= 3, `the numbers strip shows the rules and the live data date (${asOfText}), with "Did you know?" facts (${q.facts})`);
    check(q.numbers.includes("of the premium, at least 0.05% of the price"), "the numbers strip states the option spread in full");
    const box = await p.evaluate(() => {
      const f = getComputedStyle(document.querySelector("#screen-how .how-fact"));
      const page = getComputedStyle(document.body).backgroundColor;
      return { border: parseFloat(f.borderTopWidth), bg: f.backgroundColor, page };
    });
    check(box.border >= 1, `"Did you know?" boxes have a visible edge (border ${box.border}px, ${box.bg} on ${box.page})`);
    await p.click('[data-how-depth="full"]');
    await p.click("#howTerms");
    const f = await view();
    check(f.open === f.folds && f.defsShown === f.defs && f.defs >= 20 && f.words > q.words + 400, `Full detail opens every fold and Explain terms shows ${f.defsShown} definitions (${f.words} words)`);
    await p.locator("#screen-how details.how-more > summary").first().click();
    check((await view()).open === f.folds - 1, "a single fold still closes on its own in Full detail");
    await p.reload();
    await p.waitForSelector("#screen-how:not([hidden])");
    const r = await view();
    check(r.open === r.folds && r.defsShown === r.defs && r.quick === "false" && r.terms === "true", "the reading view and Explain terms are remembered after a reload");
    const dash = await p.evaluate(() => /\u2014/.test(document.querySelector("#screen-how").innerText));
    check(!dash, "How it works has no em dashes");
    const doubled = await p.evaluate(() => ([...document.querySelectorAll("#screen-how p:not(.formula), #screen-how li")].map((e) => e.innerText).join("\n").match(/\(\S[^()]*\([^()]*\)[^()]*\)|\)\s*\(/g) || []).map((s) => s.slice(0, 40)));
    check(doubled.length === 0, `with Explain terms on, no definition sits in doubled brackets${doubled.length ? ": " + doubled.join(" | ") : ""}`);
    await c.close();
    // On a phone, with everything open, nothing scrolls sideways and the controls are 44px.
    const m = await fresh({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    await m.p.goto(`http://127.0.0.1:${PORT}/#/how`);
    await m.p.waitForSelector("#screen-how:not([hidden])");
    await m.p.click('[data-how-depth="full"]');
    await m.p.click("#howTerms");
    const ph = await m.p.evaluate(() => ({
      over: document.documentElement.scrollWidth - innerWidth,
      small: [...document.querySelectorAll("#screen-how [data-how-depth], #howTerms, #screen-how details.how-more > summary")].filter((b) => b.getBoundingClientRect().height < 44).length,
    }));
    check(ph.over <= 0 && ph.small === 0, `How it works on a 320px phone: no sideways scroll (${ph.over}px) and 44px controls (${ph.small} smaller)`);
    await m.c.close();
    // The numbers strip doesn't move the page when the data arrives, at any width.
    for (const w of [734, 744, 754, 1280]) {
      const s = await fresh({ viewport: { width: w, height: 900 } });
      let release;
      const gate = new Promise((ok) => { release = ok; });
      await s.p.route("**/data/meta.json", async (r) => { await gate; await r.continue(); });
      await s.p.goto(`http://127.0.0.1:${PORT}/#/how`);
      await s.p.waitForSelector("#screen-how:not([hidden])");
      const before = await s.p.evaluate(() => document.querySelector("#howNumbers").getBoundingClientRect().height);
      release();
      await s.p.waitForFunction(() => /\d{4}/.test(document.querySelector("#howNumbers").textContent), null, { timeout: 4000 }).catch(() => {});
      const after = await s.p.evaluate(() => document.querySelector("#howNumbers").getBoundingClientRect().height);
      check(Math.abs(after - before) < 1, `at ${w}px the numbers strip keeps its height when the data arrives (${before} -> ${after})`);
      await s.c.close();
    }
    // In forced colors (high contrast) the chosen reading view keeps a readable label.
    const hc = await fresh({ forcedColors: "active" });
    await hc.p.goto(`http://127.0.0.1:${PORT}/#/how`);
    await hc.p.waitForSelector("#screen-how:not([hidden])");
    const seg = await hc.p.evaluate(() => {
      const s = getComputedStyle(document.querySelector('[data-how-depth][aria-pressed="true"]'));
      return { color: s.color, bg: s.backgroundColor, adjust: s.forcedColorAdjust };
    });
    check(seg.color !== seg.bg && seg.adjust === "none", `in forced colors the chosen reading view stays readable (${seg.color} on ${seg.bg})`);
    await hc.c.close();
  });

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
