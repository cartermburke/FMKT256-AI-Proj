// Performance metrics computed on the daily equity curve.

const TD = 252;

export function dailyReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    out.push(equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0);
  }
  return out;
}

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs, ddof = 1) {
  if (xs.length <= ddof) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - ddof));
}

/** Excess daily returns over the daily risk-free rate (rf[i] applies to return i). */
export function excess(returns, rfDaily) {
  return returns.map((r, i) => r - (rfDaily ? rfDaily[i] : 0));
}

/** Annualized Sharpe ratio of daily returns in excess of the T-bill rate. */
export function sharpe(returns, rfDaily) {
  const ex = excess(returns, rfDaily);
  const sd = stdev(ex);
  const m = mean(ex);
  // A riskless curve (e.g. T-bills only) has zero excess return: Sharpe 0, not noise.
  if (!(sd > 1e-12)) return Math.abs(m) <= 1e-12 ? 0 : NaN;
  return (m / sd) * Math.sqrt(TD);
}

/** Annualized Sortino ratio (downside deviation of excess returns, target 0). */
export function sortino(returns, rfDaily) {
  const ex = excess(returns, rfDaily);
  const dd = Math.sqrt(mean(ex.map((x) => Math.min(0, x) ** 2)));
  const m = mean(ex);
  if (!(dd > 1e-12)) return Math.abs(m) <= 1e-12 ? 0 : NaN;
  return (m / dd) * Math.sqrt(TD);
}

export function annualVol(returns) {
  return stdev(returns) * Math.sqrt(TD);
}

/** Maximum peak-to-trough decline of the equity curve, with its location. */
export function maxDrawdown(equity) {
  let peak = equity[0];
  let peakIdx = 0;
  let mdd = 0;
  let from = 0;
  let to = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i];
      peakIdx = i;
    }
    const dd = peak > 0 ? 1 - equity[i] / peak : 0;
    if (dd > mdd) {
      mdd = dd;
      from = peakIdx;
      to = i;
    }
  }
  return { mdd, from, to };
}

export function drawdownSeries(equity) {
  let peak = -Infinity;
  return equity.map((e) => {
    peak = Math.max(peak, e);
    return peak > 0 ? e / peak - 1 : 0;
  });
}

export function beta(returns, benchReturns) {
  const n = Math.min(returns.length, benchReturns.length);
  if (n < 2) return NaN;
  const a = returns.slice(0, n);
  const b = benchReturns.slice(0, n);
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    vb += (b[i] - mb) ** 2;
  }
  return vb > 0 ? cov / vb : NaN;
}

const DAY_MS = 86400000;

function yearFrac(d0, d) {
  return (Date.parse(d) - Date.parse(d0)) / DAY_MS / 365;
}

/**
 * Money-weighted IRR (XIRR, Actual/365) of dated cash flows.
 * flows: [{date: "YYYY-MM-DD", amount}] with investor sign convention
 * (deposits negative, withdrawals / ending value positive).
 */
export function xirr(flows) {
  if (flows.length < 2) return NaN;
  const d0 = flows[0].date;
  const npv = (rate) => flows.reduce((s, f) => s + f.amount / (1 + rate) ** yearFrac(d0, f.date), 0);
  const hasNeg = flows.some((f) => f.amount < 0);
  const hasPos = flows.some((f) => f.amount > 0);
  if (!hasNeg) return NaN;
  if (!hasPos) return -1; // everything lost
  // Bisection on (-0.9999, hi], expanding hi until the sign changes. NPV is
  // monotone decreasing in rate for a single initial outflow.
  let lo = -0.9999;
  let hi = 1;
  let flo = npv(lo);
  let fhi = npv(hi);
  let guard = 0;
  while (flo * fhi > 0 && guard++ < 60) {
    hi *= 2;
    fhi = npv(hi);
  }
  if (flo * fhi > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (fm * flo > 0) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export function cagr(startValue, endValue, startDate, endDate) {
  const yrs = yearFrac(startDate, endDate);
  if (!(yrs > 0) || !(startValue > 0)) return NaN;
  if (endValue <= 0) return -1;
  return (endValue / startValue) ** (1 / yrs) - 1;
}

/** Compound annual growth of the T-bill account over the same window (Actual/365). */
export function tbillCagr(rfDaily, startDate, endDate) {
  let g = 1;
  for (const r of rfDaily || []) g *= 1 + r;
  return cagr(1, g, startDate, endDate);
}

/**
 * Return per unit of drawdown (Calmar-style): IRR in excess of T-bills ÷ max drawdown.
 * Like Sharpe it doesn't change with position size, so a tiny position can't look good
 * just by being small. Drawdowns under 1% are floored at 1% to avoid dividing by ~0.
 */
export function returnToDrawdown(irr, rfIrr, mdd) {
  const ex = irr - (Number.isFinite(rfIrr) ? rfIrr : 0);
  if (!Number.isFinite(ex)) return NaN;
  return ex / Math.max(mdd, 0.01);
}

/** Full scorecard for one equity curve. */
export function scorecard({ equity, dates, rfDaily, benchReturns, flows }) {
  const rets = dailyReturns(equity);
  const dd = maxDrawdown(equity);
  const start = equity[0];
  const end = equity[equity.length - 1];
  const irr = xirr(flows ?? [
    { date: dates[0], amount: -start },
    { date: dates[dates.length - 1], amount: Math.max(0, end) },
  ]);
  const rfIrr = tbillCagr(rfDaily, dates[0], dates[dates.length - 1]);
  return {
    rfIrr,
    retToDD: returnToDrawdown(irr, rfIrr, dd.mdd),
    finalValue: end,
    totalReturn: end / start - 1,
    sharpe: sharpe(rets, rfDaily),
    sortino: sortino(rets, rfDaily),
    maxDrawdown: dd.mdd,
    ddFrom: dd.from,
    ddTo: dd.to,
    irr,
    cagr: cagr(start, end, dates[0], dates[dates.length - 1]),
    vol: annualVol(rets),
    beta: benchReturns ? beta(rets, benchReturns) : NaN,
  };
}
