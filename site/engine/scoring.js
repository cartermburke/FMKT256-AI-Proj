// Overall ranking. The assignment judges a trading game on Sharpe ratio, maximum drawdown
// and IRR. Each strategy is ranked on three numbers and ordered by the average rank:
//   - Sharpe ratio (return per unit of volatility),
//   - return-to-drawdown (IRR in excess of T-bills ÷ max drawdown), which is how maximum
//     drawdown enters the score,
//   - IRR (the raw return).
// Raw max drawdown isn't averaged in directly: it shrinks with position size while Sharpe
// doesn't, so a tiny near-cash position would collect two good ranks for free. Busted
// accounts always rank last. Exact ties share a rank.

export const RANK_METRICS = [
  { key: "sharpe", label: "Sharpe" },
  { key: "retToDD", label: "Return/drawdown" },
  { key: "irr", label: "IRR" },
];

const val = (r, key) => {
  const v = r.results[key];
  return Number.isFinite(v) ? v : -Infinity; // bust / not meaningful ranks last
};
const same = (a, b) => (a === b) || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

function rankBy(rows, key) {
  const sorted = [...rows].sort((a, b) => val(b, key) - val(a, key));
  const ranks = new Map();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    ranks.set(r, prev && same(val(prev, key), val(r, key)) ? ranks.get(prev) : i + 1);
  });
  return ranks;
}

/**
 * rows: [{ key, results: {sharpe, retToDD, irr, maxDrawdown, busted?}, ...}]
 * Returns the rows sorted best-first, each with .ranks {sharpe, retToDD, irr}, .avgRank,
 * .overall (competition ranking: exact ties share a number) and .tiedWith (keys).
 */
export function rankStrategies(rows) {
  const per = RANK_METRICS.map((m) => rankBy(rows, m.key));
  const out = rows.map((r) => {
    const ranks = {};
    RANK_METRICS.forEach((m, i) => { ranks[m.key] = per[i].get(r); });
    const avgRank = RANK_METRICS.reduce((s, m) => s + ranks[m.key], 0) / RANK_METRICS.length;
    return { ...r, ranks, avgRank };
  });
  const cmp = (a, b) => {
    const ba = a.results.busted ? 1 : 0;
    const bb = b.results.busted ? 1 : 0;
    if (ba !== bb) return ba - bb;
    if (!same(a.avgRank, b.avgRank)) return a.avgRank - b.avgRank;
    for (const k of ["sharpe", "irr", "retToDD"]) if (!same(val(a, k), val(b, k))) return val(b, k) - val(a, k);
    return 0;
  };
  // Stable sort; on an exact tie, benchmarks are listed before "you".
  out.sort((a, b) => cmp(a, b) || (a.key === "you") - (b.key === "you"));
  out.forEach((r, i) => {
    const prev = out[i - 1];
    r.overall = prev && cmp(prev, r) === 0 ? prev.overall : i + 1;
  });
  for (const r of out) r.tiedWith = out.filter((o) => o !== r && o.overall === r.overall).map((o) => o.key);
  return out;
}
