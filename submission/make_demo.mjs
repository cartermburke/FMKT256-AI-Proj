// Plays a full blind demo game with a scripted, rule-based "player" and prints its replay
// link plus a summary. Used to give graders a one-click example result.
//   node submission/make_demo.mjs [SYMBOL]
import { readFileSync, writeFileSync } from "node:fs";
import { buildMarket } from "../site/engine/market.js";
import { Game, RULES, normalizeAction, legalize } from "../site/engine/game.js";
import { runBenchmarks } from "../site/engine/strategies.js";
import { encodeReplay } from "../site/engine/replay.js";

const TEAM = JSON.parse(readFileSync(new URL("./team.json", import.meta.url)));
const SITE = process.env.SITE_URL || TEAM.site_url;
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

function scripted(sym) {
  const bundle = { stock: load(sym), spy: load("SPY"), vix: load("VIX"), irx: load("IRX") };
  const m = buildMarket(bundle, { endDate: meta.as_of });
  const spyM = buildMarket({ stock: bundle.spy, spy: bundle.spy, vix: bundle.vix, irx: bundle.irx }, { endDate: meta.as_of });
  const startIdx = m.last - meta.game_years * 12 * RULES.turnDays;
  const g = new Game(m, { startIdx, turns: meta.game_years * 12 });
  const actions = [];
  while (!g.over) {
    const a = legalize(g, rule(g.context(), m));
    g.play(a);
    actions.push(a);
  }
  const bh = runBenchmarks(m, { startIdx, turns: meta.game_years * 12 }, spyM).find((b) => b.key === "buyHold").results;
  return { g, res: g.results(), bh, actions };
}

// The scripted player: trend + volatility aware.
//  - Above the 200-day average: long 100%; when implied vol is rich (VIX > 22), write 105% calls.
//  - Below it: 25% long with 95% puts as insurance when the VIX is elevated, otherwise flat.
function rule(c, mk) {
  const vix = mk.vix[c.idx];
  if (c.S > c.sma200) return { stock: 1, legs: vix > 22 ? [{ side: "W", type: "C", strike: 105, notional: 1 }] : [] };
  return vix > 22 ? { stock: 0.25, legs: [{ side: "B", type: "P", strike: 95, notional: 0.25 }] } : { stock: 0, legs: [] };
}
const actions = [];
while (!g.over) {
  const a = legalize(g, rule(g.context(), m));
  g.play(a);
  actions.push(normalizeAction(a));
}
const res = g.results();
const bh = runBenchmarks(m, { startIdx, turns: cfg.turns }, spyM).find((b) => b.key === "buyHold").results;
const url = `${SITE}#/replay/${encodeReplay(cfg, actions)}`;
// How the same rule does on every stock in the pool (for an honest summary in the PDF).
const across = meta.pool.map((s2) => {
  const r = scripted(s2);
  const beatAll = r.res.sharpe > r.bh.sharpe && r.res.maxDrawdown < r.bh.maxDrawdown && r.res.irr > r.bh.irr;
  return { symbol: s2, sharpe: r.res.sharpe, bhSharpe: r.bh.sharpe, mdd: r.res.maxDrawdown, bhMdd: r.bh.maxDrawdown, irr: r.res.irr, bhIrr: r.bh.irr, beatAll };
});
const out = { symbol: sym, url, as_of: cfg.end, you: res, buyHold: bh, across };
writeFileSync(new URL("./demo.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`${sym}: you Sharpe ${res.sharpe.toFixed(2)} MDD ${(res.maxDrawdown * 100).toFixed(1)}% IRR ${(res.irr * 100).toFixed(1)}% | buy&hold Sharpe ${bh.sharpe.toFixed(2)} MDD ${(bh.maxDrawdown * 100).toFixed(1)}% IRR ${(bh.irr * 100).toFixed(1)}%`);
console.log(url);
