// Plays a full blind demo game with a scripted, rule-based "player" and prints its replay
// link plus a summary. Used to give graders a one-click example result.
//   node submission/make_demo.mjs [SYMBOL]
import { readFileSync, writeFileSync } from "node:fs";
import { buildMarket } from "../site/engine/market.js";
import { Game, RULES, normalizeAction } from "../site/engine/game.js";
import { runBenchmarks } from "../site/engine/strategies.js";
import { encodeReplay } from "../site/engine/replay.js";

const SITE = process.env.SITE_URL || "https://cartermburke.github.io/FMKT256-AI-Proj/";
const DATA = new URL("../site/data/", import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(`prices/${f}.json`, DATA)));
const meta = JSON.parse(readFileSync(new URL("meta.json", DATA)));
const sym = process.argv[2] || "MU";

const bundle = { stock: load(sym), spy: load("SPY"), vix: load("VIX"), irx: load("IRX") };
const cfg = { v: 1, sym, end: meta.as_of, fullTurns: meta.game_years * 12, startTurn: 0, turns: meta.game_years * 12, blind: true, seed: 20261103, mode: "full" };
const m = buildMarket(bundle, { endDate: cfg.end });
const spyM = buildMarket({ stock: bundle.spy, spy: bundle.spy, vix: bundle.vix, irx: bundle.irx }, { endDate: cfg.end });
const startIdx = m.last - cfg.fullTurns * RULES.turnDays;
const g = new Game(m, { startIdx, turns: cfg.turns });

// The scripted player: trend + volatility aware.
//  - Above the 200-day average: long 100%; when implied vol is rich (VIX > 22), write 105% calls.
//  - Below it: 25% long with 95% puts as insurance when the VIX is elevated, otherwise flat.
const actions = [];
while (!g.over) {
  const c = g.context();
  const vix = m.vix[c.idx];
  let a;
  if (c.S > c.sma200) {
    a = { stock: 1, legs: vix > 22 ? [{ side: "W", type: "C", strike: 105, notional: 1 }] : [] };
  } else {
    a = vix > 22 ? { stock: 0.25, legs: [{ side: "B", type: "P", strike: 95, notional: 0.25 }] } : { stock: 0, legs: [] };
  }
  if (!g.check(a).ok) a = { stock: a.stock, legs: [] };
  g.play(a);
  actions.push(normalizeAction(a));
}
const res = g.results();
const bh = runBenchmarks(m, { startIdx, turns: cfg.turns }, spyM).find((b) => b.key === "buyHold").results;
const url = `${SITE}#/replay/${encodeReplay(cfg, actions)}`;
const out = { symbol: sym, url, as_of: cfg.end, you: res, buyHold: bh };
writeFileSync(new URL("./demo.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`${sym}: you Sharpe ${res.sharpe.toFixed(2)} MDD ${(res.maxDrawdown * 100).toFixed(1)}% IRR ${(res.irr * 100).toFixed(1)}% | buy&hold Sharpe ${bh.sharpe.toFixed(2)} MDD ${(bh.maxDrawdown * 100).toFixed(1)}% IRR ${(bh.irr * 100).toFixed(1)}%`);
console.log(url);
