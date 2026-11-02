// Black-Scholes pricing and the market-anchored implied-volatility model.

// Standard normal CDF (Abramowitz-Stegun 7.1.26 on erf; |error| < 1.5e-7).
export function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * European option value (no dividends; the underlying series is total-return adjusted).
 * @param {"C"|"P"} type
 * @param {number} S spot
 * @param {number} K strike
 * @param {number} T years to expiry
 * @param {number} r continuously-compounded risk-free rate (decimal)
 * @param {number} sigma annualized volatility (decimal)
 */
export function bsPrice(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) {
    return intrinsic(type, S, K);
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  if (type === "C") return S * normCdf(d1) - K * df * normCdf(d2);
  return K * df * normCdf(-d2) - S * normCdf(-d1);
}

export function bsDelta(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) {
    if (type === "C") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return type === "C" ? normCdf(d1) : normCdf(d1) - 1;
}

export function intrinsic(type, S, K) {
  return type === "C" ? Math.max(0, S - K) : Math.max(0, K - S);
}

export const IV_PARAMS = {
  window: 63,        // trading days of realized vol
  atmToVix: 0.88,    // at-the-money index vol ≈ 0.88 × VIX (the VIX is a variance-swap level that includes skew)
  minFracOfRv: 0.75, // at-the-money vol never below 75% of the stock's own realized vol
  floor: 0.08,       // never price below 8% vol
  cap: 2.5,          // or above 250%
  // Smile slopes per unit of log-moneyness, below (puts) and above (calls) the money.
  // Index: a steep, monotone skew (OTM index calls trade below ATM vol).
  // Single stocks: a milder put skew and a flat call wing (OTM stock calls are not cheap).
  skew: {
    index: { down: 3.0, up: 3.0 },
    stock: { down: 1.25, up: 0.0 },
  },
};

/** Instruments priced with index-style skew. */
export const INDEX_SYMBOLS = new Set(["SPY", "QQQ", "IWM", "DIA"]);

/**
 * At-the-money implied vol for the game stock on a given day:
 *
 *   IV_atm^2 = RV63(stock)^2 + [ (0.88 × VIX/100)^2 - RV63(SPY)^2 ]
 *
 * The bracket is the market's own variance risk premium that day, measured at the money:
 * what option buyers pay for S&P 500 volatility over what the index has actually been
 * realizing. It is added once, in variance units, to the stock's realized variance. So
 * at-the-money SPY options are priced at 0.88 × VIX, and high-vol single stocks carry only
 * a small premium over realized vol, which matches the empirical finding that the
 * volatility risk premium is concentrated in index options.
 */
export function impliedVol(rvStock, rvSpy, vixLevel, p = IV_PARAMS) {
  const atmIdx = (p.atmToVix * vixLevel) / 100;
  const v2 = rvStock * rvStock + atmIdx * atmIdx - rvSpy * rvSpy;
  const lo = p.minFracOfRv * rvStock;
  const iv = Math.sqrt(Math.max(v2, lo * lo));
  return Math.min(p.cap, Math.max(p.floor, iv));
}

/**
 * Volatility smile: IV(K) = IV_atm × (1 − slope × ln(K/S)), clipped to [0.5, 2] × IV_atm,
 * with separate slopes below the money (puts richer) and above it (index calls cheaper,
 * single-stock calls flat). `skew` is {down, up} or a single number for both.
 */
export function smileVol(atm, moneyness, skew, p = IV_PARAMS) {
  const k = Math.log(moneyness);
  const slope = typeof skew === "number" ? skew : k < 0 ? skew.down : skew.up;
  const v = atm * (1 - slope * k);
  const clipped = Math.min(2 * atm, Math.max(0.5 * atm, v));
  return Math.min(p.cap, Math.max(p.floor, clipped));
}

export const SPREAD = {
  halfPct: 0.025,      // half bid/ask spread as a fraction of mid premium
  minHalfOfSpot: 0.0005, // minimum half-spread as a fraction of spot (5 bps)
};

/** Price a trade at the bid (writes) or ask (buys). */
export function tradePrice(mid, spot, side, p = SPREAD) {
  const half = Math.max(p.halfPct * mid, p.minHalfOfSpot * spot);
  return side === "B" ? mid + half : Math.max(0, mid - half);
}
