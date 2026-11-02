// Runs every benchmark strategy on every ticker over the full 5-year window using the
// committed real data, then writes the equity curves and the JS metrics to
// tests/artifacts/curves.json for an independent pandas cross-check (check_metrics.py).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { buildMarket } from "../site/engine/market.js";
import { runBenchmarks } from "../site/engine/strategies.js";
import { RULES } from "../site/engine/game.js";

const DATA = new URL("../site/data/", import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(`prices/${f}.json`, DATA)));
const meta = JSON.parse(readFileSync(new URL("meta.json", DATA)));
const spy = load("SPY");
const vix = load("VIX");
const irx = load("IRX");
const turns = meta.game_years * 12;

const out = [];
for (const sym of meta.pool) {
  const stock = load(sym);
  const m = buildMarket({ stock, spy, vix, irx });
  const spyM = buildMarket({ stock: spy, spy, vix, irx });
  const startIdx = m.last - turns * RULES.turnDays;
  const benches = runBenchmarks(m, { startIdx, turns }, spyM);
  for (const b of benches) {
    const g = b.game;
    out.push({
      symbol: sym,
      strategy: b.key,
      dates: g.curve.idx.map((d) => m.dates[d]),
      equity: g.curve.equity,
      rf_daily: g.rfDaily(),
      spy: g.curve.idx.map((d) => m.spy[d]),
      js: b.results,
    });
  }
}
mkdirSync(new URL("./artifacts/", import.meta.url), { recursive: true });
writeFileSync(new URL("./artifacts/curves.json", import.meta.url), JSON.stringify(out));
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : "  nan");
console.log("symbol strategy          totRet  sharpe   maxDD    irr     beta");
for (const r of out) {
  const j = r.js;
  console.log(`${r.symbol.padEnd(6)} ${r.strategy.padEnd(15)} ${fmt(j.totalReturn).padStart(7)} ${fmt(j.sharpe).padStart(7)} ${fmt(j.maxDrawdown).padStart(7)} ${fmt(j.irr).padStart(7)} ${fmt(j.beta).padStart(7)}`);
}
