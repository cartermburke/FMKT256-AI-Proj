// Benchmark strategies, auto-played through the exact same engine and costs as the player.

import { Game, autoplay } from "./game.js";

export const STRATEGIES = {
  buyHold: {
    label: "Buy & hold the stock",
    short: "Buy & hold",
    // Buys once (on its first turn, even if it takes over mid-game), then never trades.
    fn: (ctx, g, st) => (st && st.first ? { stock: 1, legs: [] } : { stock: null, legs: [] }),
  },
  coveredCall: {
    label: "Covered call (long 100%, write 105% calls monthly)",
    short: "Covered call",
    fn: () => ({ stock: 1, legs: [{ side: "W", type: "C", strike: 105, notional: 1 }] }),
  },
  protectivePut: {
    label: "Protective put (long 100%, buy 95% puts monthly)",
    short: "Protective put",
    fn: () => ({ stock: 1, legs: [{ side: "B", type: "P", strike: 95, notional: 1 }] }),
  },
  trend200: {
    label: "200-day trend (long 100% above the 200-day average, else cash)",
    short: "200-day trend",
    fn: (ctx) => ({ stock: ctx.S > ctx.sma200 ? 1 : 0, legs: [] }),
  },
  cash: {
    label: "T-bills only",
    short: "T-bills",
    fn: () => ({ stock: 0, legs: [] }),
  },
};

/** Run one named strategy on a market/window and return { game, results }. */
export function runStrategy(market, window, key) {
  const g = new Game(market, window);
  autoplay(g, STRATEGIES[key].fn);
  return { key, label: STRATEGIES[key].label, short: STRATEGIES[key].short, game: g, results: g.results() };
}

/**
 * All benchmarks for a game window. `spyMarket` (SPY as the underlying) gives the
 * market buy-and-hold line; it is aligned on the same dates as the stock window.
 */
export function runBenchmarks(market, window, spyMarket) {
  const out = ["buyHold", "coveredCall", "protectivePut", "trend200", "cash"].map((k) => runStrategy(market, window, k));
  if (spyMarket) {
    const startDate = market.dates[window.startIdx];
    const sIdx = spyMarket.dates.indexOf(startDate);
    const endDate = market.dates[window.startIdx + window.turns * 21];
    const eIdx = spyMarket.dates.indexOf(endDate);
    // SPY trades on the same NYSE calendar, so the turn grid lines up exactly.
    if (sIdx >= 0 && eIdx - sIdx === window.turns * 21) {
      const r = runStrategy(spyMarket, { startIdx: sIdx, turns: window.turns }, "buyHold");
      out.splice(1, 0, { ...r, key: "spy", label: "Buy & hold the S&P 500 (SPY)", short: "S&P 500" });
    }
  }
  return out;
}
