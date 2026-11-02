// Before/after UI captures: home, game and results at 1280 and 375 px, light and dark.
//   node tests/ui_captures.mjs <label>     -> tests/artifacts/captures/<label>/*.png
// The game capture is a blind quick round two months in with a leg on the ticket; the
// results capture is the submission's demo replay, so both states are deterministic.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const label = process.argv[2] || "now";
const PORT = 8767;
const ROOT = new URL("../site/", import.meta.url).pathname;
const OUT = new URL(`./artifacts/captures/${label}/`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const demo = JSON.parse(readFileSync(new URL("../submission/demo.json", import.meta.url)));
const code = demo.url.split("#/replay/")[1];

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch();
const errors = [];
try {
  for (const scheme of ["light", "dark"]) {
    for (const [w, h, mobile] of [[1280, 800, false], [375, 812, true]]) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
        colorScheme: scheme, reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      const tag = `${w}-${scheme}`;
      await page.goto(base);
      await page.waitForSelector("#homeData strong");
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.screenshot({ path: `${OUT}home-${tag}.png` });

      await page.click("#startQuick");
      await page.waitForSelector("#priceChart canvas");
      for (let i = 0; i < 2; i++) {
        await page.click('.quick-btns button[data-x="100"]');
        await page.click("#nextTurn");
        await page.waitForFunction((n) => document.querySelector("#sTurn").textContent.startsWith(`${n} of`), i + 2);
        await page.waitForTimeout(400);
      }
      await page.locator("#quotesTable tbody tr").nth(3).locator("button.px").nth(0).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(5, 5);
      await page.screenshot({ path: `${OUT}game-${tag}.png` });

      await page.goto(`${base}#/replay/${code}`);
      await page.waitForSelector("#resEquityChart canvas");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${OUT}results-${tag}.png` });
      await ctx.close();
    }
  }
  console.log(`12 captures written to ${OUT}${errors.length ? ` (errors: ${errors.join(" | ")})` : ""}`);
} finally {
  await browser.close();
  server.kill();
}
