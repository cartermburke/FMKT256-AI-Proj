// Aligns the raw daily series (stock, SPY, VIX, T-bill) onto the stock's trading
// calendar and precomputes realized vol, implied vol and the 200-day average.

import { impliedVol, IV_PARAMS, INDEX_SYMBOLS } from "./options.js";

/** As-of alignment: for each target date take the latest source value on or before it. */
export function alignAsOf(targetDates, srcDates, srcVals) {
  const out = new Array(targetDates.length);
  let j = -1;
  for (let i = 0; i < targetDates.length; i++) {
    while (j + 1 < srcDates.length && srcDates[j + 1] <= targetDates[i]) j++;
    out[i] = j >= 0 ? srcVals[j] : NaN;
  }
  return out;
}

/** Trailing annualized realized vol of daily log returns over `w` days (NaN until available). */
export function realizedVol(prices, w) {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  const lr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) lr[i] = Math.log(prices[i] / prices[i - 1]);
  let s = 0;
  let s2 = 0;
  for (let i = 1; i < n; i++) {
    s += lr[i];
    s2 += lr[i] * lr[i];
    if (i > w) {
      s -= lr[i - w];
      s2 -= lr[i - w] * lr[i - w];
    }
    if (i >= w) {
      const m = s / w;
      const v = Math.max(0, (s2 - w * m * m) / (w - 1));
      out[i] = Math.sqrt(v * 252);
    }
  }
  return out;
}

export function sma(prices, w) {
  const out = new Array(prices.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < prices.length; i++) {
    s += prices[i];
    if (i >= w) s -= prices[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}

/**
 * Build the aligned market for one underlying.
 * raw = { stock, spy, vix, irx } where each is { dates: [...], close: [...] }.
 * Returns arrays indexed by trading day on the stock's calendar.
 */
export function buildMarket(raw, { endDate } = {}) {
  let dates = raw.stock.dates.slice();
  let px = raw.stock.close.slice();
  if (endDate) {
    let k = dates.length;
    while (k > 0 && dates[k - 1] > endDate) k--;
    dates = dates.slice(0, k);
    px = px.slice(0, k);
  }
  const spy = alignAsOf(dates, raw.spy.dates, raw.spy.close);
  const vix = alignAsOf(dates, raw.vix.dates, raw.vix.close);
  const irx = alignAsOf(dates, raw.irx.dates, raw.irx.close);
  const rate = irx.map((v) => (Number.isFinite(v) ? v / 100 : 0.0));
  const rvStock = realizedVol(px, IV_PARAMS.window);
  const rvSpy = realizedVol(spy, IV_PARAMS.window);
  const iv = px.map((_, i) =>
    Number.isFinite(rvStock[i]) && Number.isFinite(rvSpy[i]) && Number.isFinite(vix[i])
      ? impliedVol(rvStock[i], rvSpy[i], vix[i])
      : NaN,
  );
  return {
    symbol: raw.stock.symbol,
    name: raw.stock.name,
    skew: INDEX_SYMBOLS.has(raw.stock.symbol) ? IV_PARAMS.skew.index : IV_PARAMS.skew.stock,
    dates,
    price: px,
    spy,
    vix,
    rate,
    rvStock,
    rvSpy,
    iv,
    sma200: sma(px, 200),
    get last() {
      return dates.length - 1;
    },
  };
}

/** First index from which IV, SMA200 and SPY data are all available. */
export function firstUsableIndex(m) {
  for (let i = 0; i < m.dates.length; i++) {
    if (Number.isFinite(m.iv[i]) && Number.isFinite(m.sma200[i]) && Number.isFinite(m.spy[i])) return i;
  }
  return -1;
}
