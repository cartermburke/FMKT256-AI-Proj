// Captures curated screenshots for the submission PDF from a local server.
//   node submission/screenshots.mjs   (writes submission/img/*.png)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PORT = 8766;
const ROOT = new URL("../site/", import.meta.url).pathname;
const OUT = new URL("./img/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const demo = JSON.parse(readFileSync(new URL("./demo.json", import.meta.url)));
const code = demo.url.split("#/replay/")[1];

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1010 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();

  await page.goto(base);
  await page.waitForSelector("#homeData strong");
  await page.waitForSelector("#tapeDemo.ready"); // the sample tape is drawn from real prices once they load
  await page.screenshot({ path: OUT + "home.png" });
  // The data date these screenshots show: build_pdf.py checks it against site/data and the demo.
  const asOf = await page.evaluate(() => fetch("data/meta.json").then((r) => r.json()).then((m) => m.as_of));

  // A blind full game at month 9, long 100% with a covered call just added from the quotes. The frame is tall
  // enough to show the whole ticket: the leg, the before-and-after preview and the bottom bar.
  await page.setViewportSize({ width: 1280, height: 1190 });
  await page.click("#startFull");
  await page.waitForSelector("#priceChart canvas");
  for (let i = 0; i < 8; i++) {
    await page.click(i % 3 === 0 ? '.quick-btns button[data-x="100"]' : '.quick-btns button[data-x="50"]');
    await page.click("#nextTurn");
    await page.waitForFunction((n) => document.querySelector("#sTurn").textContent.startsWith(`${n} of`), i + 2);
  }
  await page.click('.quick-btns button[data-x="100"]');
  await page.locator("#quotesTable tbody tr").nth(3).locator("button.px").nth(0).click();
  await page.waitForFunction(() => !document.querySelector("#nextTurn").disabled);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(5, 5); // off the charts, so their legends show the latest month
  await page.screenshot({ path: OUT + "game.png", fullPage: false });
  await page.setViewportSize({ width: 1280, height: 1010 });

  // The demo replay's results.
  await page.goto(`${base}#/replay/${code}`);
  await page.waitForSelector("#resEquityChart canvas");
  await page.screenshot({ path: OUT + "results.png", fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const tiles = await page.locator(".tiles").boundingBox();
  await page.screenshot({ path: OUT + "reveal.png", clip: { x: 0, y: 60, width: 1280, height: tiles.y + tiles.height + 16 - 60 } });
  const card = page.locator("#screen-results .card", { has: page.locator("#scoreTable") });
  await card.screenshot({ path: OUT + "scorecard.png" });
  await page.locator("#coachNotes").screenshot({ path: OUT + "coach.png" });

  // A head-to-head: challenge a friend from the demo game, friend plays the trend rule.
  await page.fill("#challengeName", "Demo player");
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#challengeBtn");
  await page.waitForFunction(() => document.querySelector("#copyMsg").textContent.includes("Challenge link copied"));
  const link = await page.evaluate(() => navigator.clipboard.readText());
  if (!link.includes("#/challenge/")) throw new Error(`unexpected clipboard: ${link.slice(0, 80)}`);
  const fp = await ctx.newPage();
  // The month-9 game above is still saved in this browser: opening the challenge asks before replacing it.
  fp.on("dialog", (d) => d.accept());
  await fp.goto(link);
  await fp.waitForSelector("#priceChart canvas");
  await fp.locator("#h2hBanner").screenshot({ path: OUT + "h2h-banner.png" });
  await fp.click(".autopilot summary");
  await fp.selectOption("#autoStrat", "trend200");
  await fp.click("#autoRun");
  await fp.waitForSelector("#h2hCard:not([hidden])");
  await fp.evaluate(() => window.scrollTo(0, 0));
  await fp.locator("#h2hCard").screenshot({ path: OUT + "h2h.png" });
  await fp.close();

  await page.goto(`${base}#/data`);
  await page.waitForSelector("#dataTable tbody tr");
  await page.screenshot({ path: OUT + "data.png" });

  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const pm = await mob.newPage();
  await pm.goto(`${base}#/replay/${code}`);
  await pm.waitForSelector("#resEquityChart canvas");
  await pm.screenshot({ path: OUT + "mobile.png" });
  writeFileSync(OUT + "as_of.json", JSON.stringify({ as_of: asOf }) + "\n");
  console.log("screenshots written to", OUT, "for data through", asOf);
} finally {
  await browser.close();
  server.kill();
}
