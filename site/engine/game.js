// The trading engine: one stock plus 1-month European options, rebalanced monthly,
// marked to market daily. Pure functions + a small class; no DOM access.

import { bsPrice, bsDelta, intrinsic, tradePrice, smileVol } from "./options.js";
import { scorecard, dailyReturns } from "./metrics.js";

export const RULES = Object.freeze({
  stake: 100000,
  turnDays: 21,            // trading days per turn (~1 month); options expire at turn end
  maxLong: 1.5,            // max long exposure (stock + option delta), fraction of equity
  maxShort: 1.0,           // max short exposure (stock + option delta), fraction of equity
  stockCostBps: 5,         // commission + slippage on stock trades, bps of notional
  marginSpread: 0.015,     // debit balances pay T-bill + 1.5%
  borrowFee: 0.005,        // short stock pays 0.5%/yr on short notional
  maxBorrowFrac: 0.5,      // an order may not take borrowing above 50% of equity
  maintenance: 0.25,       // margin call if equity < 25% of gross stock notional (any daily close)
  strikes: [90, 95, 100, 105, 110],
  maxLegs: 4,
  maxOptionNotional: 2.0,  // all option legs together: at most 200% of equity notional
});

const EPS = 1e-9;

/** Continuous-compounding equivalent of the annual T-bill yield for Black-Scholes. */
const cont = (r) => Math.log(1 + r);

export class Game {
  /**
   * @param {object} market  output of buildMarket()
   * @param {object} cfg     { startIdx, turns, rules? }
   */
  constructor(market, cfg) {
    this.m = market;
    this.rules = { ...RULES, ...(cfg.rules || {}) };
    this.turns = cfg.turns;
    this.startIdx = cfg.startIdx;
    this.endIdx = cfg.startIdx + cfg.turns * this.rules.turnDays;
    if (!(Number.isInteger(cfg.turns) && cfg.turns > 0)) throw new Error("invalid number of turns");
    if (this.endIdx > market.last) throw new Error("game window exceeds available data");
    if (!(cfg.startIdx >= 0) || !Number.isFinite(market.iv[cfg.startIdx])) {
      throw new Error("not enough history before the game start");
    }
    this.skew = market.skew ?? 1.25;
    // Everything runs on prices rebased to 100 at the start (returns are unchanged).
    this.base = 100 / market.price[cfg.startIdx];
    this.S = market.price.map((p) => p * this.base);

    this.turn = 0;
    this.idx = cfg.startIdx;
    this.cash = this.rules.stake;
    this.shares = 0;
    this.legs = [];
    this.over = false;
    this.busted = false;
    this.events = [];
    this.log = [];
    this.curve = { idx: [cfg.startIdx], equity: [this.rules.stake], exposure: [0] };
    this.attr = { stock: 0, options: 0, interest: 0, borrow: 0, costs: 0, spread: 0 };
  }

  // ------------------------------------------------------------------ views

  get equity() {
    return this.curve.equity[this.curve.equity.length - 1];
  }

  exposure() {
    const e = this.equity;
    return e > 0 ? (this.shares * this.S[this.idx]) / e : 0;
  }

  /** Implied vol for a strike on day d (at-the-money vol + smile). */
  vol(d, K) {
    return smileVol(this.m.iv[d], K / this.S[d], this.skew);
  }

  /** Quotes for every strike at the current decision point. */
  quotes() {
    const i = this.idx;
    const S = this.S[i];
    const T = this.rules.turnDays / 252;
    const r = cont(this.m.rate[i]);
    const rows = this.rules.strikes.map((k) => {
      const K = (S * k) / 100;
      const iv = this.vol(i, K);
      const out = { strike: k, K, iv };
      for (const type of ["C", "P"]) {
        const mid = bsPrice(type, S, K, T, r, iv);
        out[type] = { mid, bid: tradePrice(mid, S, "W"), ask: tradePrice(mid, S, "B"), delta: bsDelta(type, S, K, T, r, iv) };
      }
      return out;
    });
    return { S, iv: this.m.iv[i], r: this.m.rate[i], T, rows };
  }

  context() {
    return {
      turn: this.turn,
      turns: this.turns,
      idx: this.idx,
      S: this.S[this.idx],
      sma200: this.m.sma200[this.idx] * this.base,
      equity: this.equity,
      shares: this.shares,
      exposure: this.exposure(),
      cash: this.cash,
      iv: this.m.iv[this.idx],
      rate: this.m.rate[this.idx],
      over: this.over,
    };
  }

  // ------------------------------------------------------------------ actions

  /**
   * Validate an action without applying it. Returns { ok, errors, preview }.
   * action = { stock: targetExposure|null, legs: [{side:"B"|"W", type:"C"|"P", strike, notional}] }
   * `stock: null` keeps the current share count. `notional` is a fraction of current equity
   * (e.g. 1.0 = options on as many shares as your equity would buy).
   *
   * Limits apply to what an order changes; positions that drift with the market between
   * orders are policed by the daily maintenance margin instead.
   */
  check(action) {
    const R = this.rules;
    const errors = [];
    const i = this.idx;
    const S = this.S[i];
    const E = this.equity;
    if (this.over) errors.push("The game is over.");
    if (!action || typeof action !== "object") return { ok: false, errors: ["Invalid order."], preview: null };
    const q0 = this.shares;
    const cash0 = this.cash;
    let q = q0;
    let cash = cash0;
    let costs = 0;
    if (action.stock !== null && action.stock !== undefined) {
      const x = Number(action.stock);
      if (!Number.isFinite(x)) {
        errors.push("Stock target must be a number.");
      } else {
        if (x > R.maxLong + EPS) errors.push(`Max long stock position is ${R.maxLong * 100}%.`);
        if (x < -R.maxShort - EPS) errors.push(`Max short stock position is ${R.maxShort * 100}%.`);
        const qNew = (x * E) / S;
        const traded = Math.abs(qNew - q) * S;
        const cost = (traded * R.stockCostBps) / 10000;
        cash -= (qNew - q) * S + cost;
        costs += cost;
        q = qNew;
      }
    }
    const legs = Array.isArray(action.legs) ? action.legs : [];
    if (legs.length > R.maxLegs) errors.push(`At most ${R.maxLegs} option legs per month.`);
    const T = R.turnDays / 252;
    const r = cont(this.m.rate[i]);
    const priced = [];
    let writtenCallShares = 0;
    let putCollateral = 0;
    let spread = 0;
    let totalNotional = 0;
    let optDeltaShares = 0;
    for (const leg of legs) {
      if (!leg || !["B", "W"].includes(leg.side) || !["C", "P"].includes(leg.type)) {
        errors.push("Invalid option leg.");
        continue;
      }
      if (!R.strikes.includes(Number(leg.strike))) {
        errors.push(`Strike ${leg.strike}% is not offered.`);
        continue;
      }
      const notional = Number(leg.notional);
      if (!(notional > 0) || notional > R.maxOptionNotional + EPS) {
        errors.push(`Option size must be between 0 and ${R.maxOptionNotional * 100}% of equity.`);
        continue;
      }
      totalNotional += notional;
      const n = (notional * E) / S;
      const K = (S * Number(leg.strike)) / 100;
      const iv = this.vol(i, K);
      const mid = bsPrice(leg.type, S, K, T, r, iv);
      const px = tradePrice(mid, S, leg.side);
      const delta = bsDelta(leg.type, S, K, T, r, iv);
      spread += Math.abs(px - mid) * n;
      if (leg.side === "B") cash -= n * px;
      else cash += n * px;
      optDeltaShares += (leg.side === "B" ? 1 : -1) * n * delta;
      if (leg.side === "W" && leg.type === "C") writtenCallShares += n;
      if (leg.side === "W" && leg.type === "P") putCollateral += n * K;
      priced.push({ ...leg, strike: Number(leg.strike), notional, n, K, iv, mid, px, delta });
    }
    if (totalNotional > R.maxOptionNotional + EPS) {
      errors.push(`All option legs together are capped at ${R.maxOptionNotional * 100}% of equity.`);
    }
    // Net exposure = stock + option deltas. It must be within the caps, unless the order
    // only reduces an exposure that has drifted past them.
    const keepExp = E > 0 ? (q0 * S) / E : 0;
    const netExp = E > 0 ? ((q + optDeltaShares) * S) / E : 0;
    if (netExp > R.maxLong + 1e-6 && netExp > keepExp + 1e-6) {
      errors.push(`Net long exposure (stock + option delta) would be ${Math.round(netExp * 100)}%; the cap is ${R.maxLong * 100}%.`);
    }
    if (netExp < -R.maxShort - 1e-6 && netExp < keepExp - 1e-6) {
      errors.push(`Net short exposure (stock + option delta) would be ${Math.round(-netExp * 100)}%; the cap is ${R.maxShort * 100}%.`);
    }
    if (writtenCallShares > Math.max(0, q) * (1 + 1e-7) + EPS) {
      errors.push("Written calls must be covered by long shares you hold.");
    }
    // Cash-secured puts: the strike value must be covered by the cash left after the whole
    // order, excluding short-sale proceeds (which already collateralize the short).
    const securingCash = cash - Math.max(0, -q) * S;
    if (putCollateral > Math.max(0, securingCash) * (1 + 1e-7) + EPS) {
      errors.push("Written puts must be cash-secured: you need cash equal to the strike value after this order.");
    }
    // Borrowing: an order may not take the debit above 50% of equity. Trading costs are
    // excluded (so 150% long is reachable), and holding a position that drifted is allowed.
    const borrowAfter = Math.max(0, -(cash + costs));
    const borrowBefore = Math.max(0, -cash0);
    if (borrowAfter > R.maxBorrowFrac * E + 1e-6 && borrowAfter > borrowBefore + 1e-6) {
      errors.push(`Not enough buying power: an order can't take borrowing above ${R.maxBorrowFrac * 100}% of equity.`);
    }
    return {
      ok: errors.length === 0,
      errors,
      preview: { shares: q, cash, legs: priced, costs, spread, putCollateral, writtenCallShares, netExp, totalNotional },
    };
  }

  /** Apply an action and simulate one turn (≈1 month) of daily marks. */
  play(action) {
    const chk = this.check(action);
    if (!chk.ok) throw new Error(chk.errors.join(" "));
    const R = this.rules;
    const i0 = this.idx;
    const E0 = this.equity;
    const p = chk.preview;
    this.shares = p.shares;
    this.cash = p.cash;
    this.attr.costs += p.costs;
    this.attr.spread += p.spread;
    const expiry = i0 + R.turnDays;
    this.legs = p.legs.map((l) => ({
      side: l.side, type: l.type, strike: l.strike, K: l.K,
      qty: l.side === "B" ? l.n : -l.n, entry: l.px, expiry,
    }));
    const premiumFlow = this.legs.reduce((s, l) => s - l.qty * l.entry, 0);
    const boughtPremium = this.legs.reduce((s, l) => s + (l.qty > 0 ? l.qty * l.entry : 0), 0);
    const writtenPremium = this.legs.reduce((s, l) => s + (l.qty < 0 ? -l.qty * l.entry : 0), 0);
    let optionPnl = premiumFlow; // grows by settlement / close-out value below
    let stockPnl = 0;
    let interest = 0;
    let borrow = 0;
    let marginCall = null;

    for (let d = i0 + 1; d <= expiry; d++) {
      const rPrev = this.m.rate[d - 1];
      const rc = this.cash >= 0 ? rPrev : rPrev + R.marginSpread;
      const int = (this.cash * rc) / 252;
      this.cash += int;
      interest += int;
      if (this.shares < 0) {
        const fee = (-this.shares * this.S[d - 1] * R.borrowFee) / 252;
        this.cash -= fee;
        borrow += fee;
      }
      stockPnl += this.shares * (this.S[d] - this.S[d - 1]);

      let optVal = 0;
      if (d === expiry) {
        for (const l of this.legs) {
          const v = l.qty * intrinsic(l.type, this.S[d], l.K);
          this.cash += v;
          optionPnl += v;
        }
        this.legs = [];
      } else {
        const T = (expiry - d) / 252;
        const r = cont(this.m.rate[d]);
        for (const l of this.legs) optVal += l.qty * bsPrice(l.type, this.S[d], l.K, T, r, this.vol(d, l.K));
      }
      let E = this.cash + this.shares * this.S[d] + optVal;

      if (E <= 0) {
        this._bust(d, E);
        break;
      }
      const gross = Math.abs(this.shares) * this.S[d];
      if (gross > 0 && E < R.maintenance * gross) {
        // Margin call (checked at every daily close, including expiry): liquidate the
        // stock and close every open option at the bid/ask.
        const cost = (gross * R.stockCostBps) / 10000;
        this.cash += this.shares * this.S[d] - cost;
        this.attr.costs += cost;
        const T = (expiry - d) / 252;
        const r = cont(this.m.rate[d]);
        for (const l of this.legs) {
          const mid = bsPrice(l.type, this.S[d], l.K, T, r, this.vol(d, l.K));
          const px = tradePrice(mid, this.S[d], l.qty > 0 ? "W" : "B");
          this.cash += l.qty * px;
          optionPnl += l.qty * px;
          this.attr.spread += Math.abs(px - mid) * Math.abs(l.qty);
        }
        marginCall = { idx: d, equity: E };
        this.events.push({ turn: this.turn, idx: d, kind: "margin", text: "Margin call: positions liquidated." });
        this.shares = 0;
        this.legs = [];
        E = this.cash;
        if (E <= 0) {
          this._bust(d, E);
          break;
        }
      }
      this._record(d, E);
    }

    // P&L attribution. Stock P&L is the price move only; trade costs are tracked separately.
    this.attr.stock += stockPnl;
    this.attr.options += optionPnl;
    this.attr.interest += interest;
    this.attr.borrow += borrow;

    const lastIdx = this.busted ? this.bustIdx : this.curve.idx[this.curve.idx.length - 1];
    const entry = {
      turn: this.turn,
      startIdx: i0,
      endIdx: lastIdx,
      action: normalizeAction(action),
      equityStart: E0,
      equityEnd: this.busted ? 0 : this.equity,
      stockReturn: this.S[lastIdx] / this.S[i0] - 1,
      exposure: (p.shares * this.S[i0]) / E0,
      netExposure: p.netExp,
      optionPnl,
      boughtPremium,
      writtenPremium,
      premiumFlow,
      marginCall,
    };
    this.log.push(entry);
    this.turn += 1;
    this.idx = this.curve.idx[this.curve.idx.length - 1];
    if (this.turn >= this.turns || this.busted) this.over = true;
    return entry;
  }

  /** Account wiped out: record zero equity through the end of the window, then stop. */
  _bust(d, E) {
    this.busted = true;
    this.over = true;
    this.bustIdx = d;
    this.events.push({ turn: this.turn, idx: d, kind: "bust", text: `Account wiped out (equity ${E < 0 ? "below" : "at"} zero).` });
    this.shares = 0;
    this.legs = [];
    this.cash = 0;
    for (let k = d; k <= this.endIdx; k++) {
      this.curve.idx.push(k);
      this.curve.equity.push(0);
      this.curve.exposure.push(0);
    }
  }

  _record(d, E) {
    this.curve.idx.push(d);
    this.curve.equity.push(Math.max(0, E));
    const e = Math.max(E, EPS);
    this.curve.exposure.push((this.shares * this.S[d]) / e);
  }

  // ------------------------------------------------------------------ results

  rfDaily() {
    // Return k (from curve point k-1 to k) earns the previous day's T-bill rate.
    return this.curve.idx.slice(1).map((d) => this.m.rate[d - 1] / 252);
  }

  results() {
    const dates = this.curve.idx.map((d) => this.m.dates[d]);
    const spy = this.curve.idx.map((d) => this.m.spy[d]);
    const card = scorecard({
      equity: this.curve.equity,
      dates,
      rfDaily: this.rfDaily(),
      benchReturns: dailyReturns(spy),
    });
    if (this.busted) {
      // A ruined account has no meaningful risk-adjusted return.
      card.sharpe = NaN;
      card.sortino = NaN;
    }
    return { ...card, dates, attr: { ...this.attr }, events: this.events.slice(), busted: this.busted };
  }
}

export function normalizeAction(a) {
  return {
    stock: a.stock === undefined || a.stock === null ? null : Number(a.stock),
    legs: (a.legs || []).map((l) => ({ side: l.side, type: l.type, strike: Number(l.strike), notional: Number(l.notional) })),
  };
}

/**
 * Pick a legal action for a strategy's wish, falling back step by step to something that
 * is always allowed (going flat with no options).
 */
export function legalize(game, action) {
  const tries = [
    action,
    { stock: action.stock ?? null, legs: [] },
    { stock: null, legs: [] },
    { stock: 0, legs: [] },
  ];
  for (const a of tries) if (game.check(a).ok) return normalizeAction(a);
  return null;
}

/**
 * Play the remaining turns with a strategy function (ctx, game, state) => action.
 * state.first is true on the strategy's first turn (so "buy & hold" buys once even when
 * it takes over mid-game). Returns the list of actions actually played.
 */
export function autoplay(game, strategy) {
  const played = [];
  const state = { first: true };
  while (!game.over) {
    const wish = strategy(game.context(), game, state);
    state.first = false;
    const a = legalize(game, wish);
    if (!a) throw new Error("No legal action available.");
    game.play(a);
    played.push(a);
  }
  return played;
}
