// Overall ranking. The assignment judges a trading game on Sharpe ratio, maximum drawdown
// AND IRR, so the scorecard ranks every strategy on each of the three and orders them by
// the average rank. Sharpe alone misorders near-riskless or losing strategies (a tiny
// negative excess return divided by a tiny volatility gives a very negative Sharpe).

const METRICS = [
  { key: "sharpe", better: "high" },
  { key: "maxDrawdown", better: "low" },
  { key: "irr", better: "high" },
];

function rankBy(rows, key, better) {
  const val = (r) => {
    const v = r.results[key];
    if (!Number.isFinite(v)) return better === "high" ? -Infinity : Infinity; // bust / n.m. ranks last
    return v;
  };
  const sorted = [...rows].sort((a, b) => (better === "high" ? val(b) - val(a) : val(a) - val(b)));
  const ranks = new Map();
  sorted.forEach((r, i) => {
    // Ties share the better rank.
    const prev = sorted[i - 1];
    ranks.set(r, prev && Math.abs(val(prev) - val(r)) < 1e-12 ? ranks.get(prev) : i + 1);
  });
  return ranks;
}

/**
 * rows: [{ key, results: {sharpe, maxDrawdown, irr, busted?} , ...}]
 * Returns the rows sorted best-first with .ranks = {sharpe, maxDrawdown, irr}, .avgRank, .overall.
 * Busted accounts always rank last.
 */
export function rankStrategies(rows) {
  const perMetric = METRICS.map((m) => rankBy(rows, m.key, m.better));
  const out = rows.map((r) => {
    const ranks = {};
    METRICS.forEach((m, i) => { ranks[m.key] = perMetric[i].get(r); });
    const avgRank = (ranks.sharpe + ranks.maxDrawdown + ranks.irr) / 3;
    return { ...r, ranks, avgRank };
  });
  out.sort((a, b) => {
    const ba = a.results.busted ? 1 : 0;
    const bb = b.results.busted ? 1 : 0;
    if (ba !== bb) return ba - bb;
    if (Math.abs(a.avgRank - b.avgRank) > 1e-9) return a.avgRank - b.avgRank;
    const sa = Number.isFinite(a.results.sharpe) ? a.results.sharpe : -Infinity;
    const sb = Number.isFinite(b.results.sharpe) ? b.results.sharpe : -Infinity;
    if (sa !== sb) return sb - sa;
    return (b.results.irr ?? -Infinity) - (a.results.irr ?? -Infinity);
  });
  out.forEach((r, i) => { r.overall = i + 1; });
  return out;
}
