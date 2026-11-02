// The trading engine: one stock plus 1-month European options, rebalanced monthly,
// marked to market daily. Pure functions + a small class; no DOM access.

import { bsPrice, intrinsic, tradePrice } from "./options.js";
import { scorecard, dailyReturns } from "./metrics.js";

export const RULES = Object.freeze({
  stake: 100000,
  turnDays: 21,          // trading days per turn (~1 month); options expire at turn end
  maxLong: 1.5,          // max long stock exposure, fraction of equity
  maxShort: 1.0,         // max short stock exposure, fraction of equity
  stockCostBps: 5,       // commission + slippage on stock trades, bps of notional
  marginSpread: 0.015,   // debit balances pay T-bill + 1.5%
  borrowFee: 0.005,      // short stock pays 0.5%/yr on short notional
  maxBorrowFrac: 0.5,    // cash may not go below -50% of equity after trades
  maintenance: 0.25,     // margin call if equity < 25% of gross stock notional
  strikes: [90, 95, 100, 105, 110],
  maxLegs: 4,
  maxLegNotional: 2.0,   // per-leg notional cap, fraction of equity
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
    if (this.endIdx > market.last) throw new Error("game window exceeds available data");
    if (!(cfg.startIdx >= 0) || !Number.isFinite(market.iv[cfg.startIdx])) {
      throw new Error("not enough history before the game start");
    }
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

  /** Quotes for every strike at the current decision point. */
  quotes() {
    const i = this.idx;
    const S = this.S[i];
    const T = this.rules.turnDays / 252;
    const r = cont(this.m.rate[i]);
    const iv = this.m.iv[i];
    const rows = this.rules.strikes.map((k) => {
      const K = (S * k) / 100;
      const out = { strike: k, K };
      for (const type of ["C", "P"]) {
        const mid = bsPrice(type, S, K, T, r, iv);
        out[type] = { mid, bid: tradePrice(mid, S, "W"), ask: tradePrice(mid, S, "B") };
      }
      return out;
    });
    return { S, iv, r: this.m.rate[i], T, rows };
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
   * `notional` is a fraction of current equity (e.g. 1.0 = options on 100% of equity).
   */
  check(action) {
    const R = this.rules;
    const errors = [];
    const i = this.idx;
    const S = this.S[i];
    const E = this.equity;
    if (this.over) errors.push("The game is over.");
    let q = this.shares;
    let cash = this.cash;
    let costs = 0;
    if (action.stock !== null && action.stock !== undefined) {
      const x = Number(action.stock);
      if (!Number.isFinite(x)) errors.push("Stock target must be a number.");
      if (x > R.maxLong + EPS) errors.push(`Max long exposure is ${R.maxLong * 100}%.`);
      if (x < -R.maxShort - EPS) errors.push(`Max short exposure is ${R.maxShort * 100}%.`);
      const qNew = (x * E) / S;
      const traded = Math.abs(qNew - q) * S;
      const cost = (traded * R.stockCostBps) / 10000;
      cash -= (qNew - q) * S + cost;
      costs += cost;
      q = qNew;
    }
    const legs = action.legs || [];
    if (legs.length > R.maxLegs) errors.push(`At most ${R.maxLegs} option legs per month.`);
    const T = R.turnDays / 252;
    const r = cont(this.m.rate[i]);
    const iv = this.m.iv[i];
    const priced = [];
    let writtenCallShares = 0;
    let putCollateral = 0;
    let spread = 0;
    for (const leg of legs) {
      if (!["B", "W"].includes(leg.side) || !["C", "P"].includes(leg.type)) {
        errors.push("Invalid option leg.");
        continue;
      }
      if (!R.strikes.includes(Number(leg.strike))) errors.push(`Strike ${leg.strike}% is not offered.`);
      const notional = Number(leg.notional);
      if (!(notional > 0) || notional > R.maxLegNotional + EPS) {
        errors.push(`Option size must be between 0 and ${R.maxLegNotional * 100}% of equity.`);
        continue;
      }
      const n = (notional * E) / S;
      const K = (S * Number(leg.strike)) / 100;
      const mid = bsPrice(leg.type, S, K, T, r, iv);
      const px = tradePrice(mid, S, leg.side);
      spread += Math.abs(px - mid) * n;
      if (leg.side === "B") cash -= n * px;
      else cash += n * px;
      if (leg.side === "W" && leg.type === "C") writtenCallShares += n;
      if (leg.side === "W" && leg.type === "P") putCollateral += n * K;
      priced.push({ ...leg, strike: Number(leg.strike), notional, n, K, mid, px });
    }
    if (writtenCallShares > Math.max(0, q) * (1 + 1e-7) + EPS) {
      errors.push("Written calls must be covered by long shares you hold.");
    }
    const free = E - Math.abs(q) * S; // equity not tied up in the stock position
    if (putCollateral > Math.max(0, free) * (1 + 1e-7) + EPS) {
      errors.push("Written puts must be cash-secured by equity not already in the stock.");
    }
    if (cash < -R.maxBorrowFrac * E - EPS) {
      errors.push(`Not enough buying power: borrowing is capped at ${R.maxBorrowFrac * 100}% of equity.`);
    }
    return {
      ok: errors.length === 0,
      errors,
      preview: { shares: q, cash, legs: priced, costs, spread, free, putCollateral, writtenCallShares },
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
    let optionPnl = premiumFlow; // grows by settlement value below
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
        for (const l of this.legs) optVal += l.qty * bsPrice(l.type, this.S[d], l.K, T, r, this.m.iv[d]);
      }
      let E = this.cash + this.shares * this.S[d] + optVal;

      const gross = Math.abs(this.shares) * this.S[d];
      if (E <= 0) {
        this._record(d, E);
        this.busted = true;
        this.over = true;
        this.events.push({ turn: this.turn, idx: d, kind: "bust", text: "Account wiped out." });
        // Close out: positions are worthless/liabilities exceed assets.
        this.shares = 0;
        this.legs = [];
        this.cash = 0;
        break;
      }
      if (gross > 0 && E < R.maintenance * gross && d < expiry) {
        // Margin call: liquidate the stock and close every option at the bid/ask.
        const cost = (gross * R.stockCostBps) / 10000;
        this.cash += this.shares * this.S[d] - cost;
        this.attr.costs += cost;
        const T = (expiry - d) / 252;
        const r = cont(this.m.rate[d]);
        for (const l of this.legs) {
          const mid = bsPrice(l.type, this.S[d], l.K, T, r, this.m.iv[d]);
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
      }
      this._record(d, E);
    }

    // P&L attribution. Stock P&L is the price move only; trade costs are tracked separately.
    this.attr.stock += stockPnl;
    this.attr.options += optionPnl;
    this.attr.interest += interest;
    this.attr.borrow += borrow;

    const iEnd = this.curve.idx[this.curve.idx.length - 1];
    this.log.push({
      turn: this.turn,
      startIdx: i0,
      endIdx: iEnd,
      action: normalizeAction(action),
      equityStart: E0,
      equityEnd: this.equity,
      stockReturn: this.S[iEnd] / this.S[i0] - 1,
      exposure: (p.shares * this.S[i0]) / E0,
      optionPnl,
      premiumFlow,
      marginCall,
    });
    this.turn += 1;
    this.idx = iEnd;
    if (this.turn >= this.turns || this.busted) this.over = true;
    return this.log[this.log.length - 1];
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
    return { ...card, dates, attr: { ...this.attr }, events: this.events.slice(), busted: this.busted };
  }
}

export function normalizeAction(a) {
  return {
    stock: a.stock === undefined || a.stock === null ? null : Number(a.stock),
    legs: (a.legs || []).map((l) => ({ side: l.side, type: l.type, strike: Number(l.strike), notional: Number(l.notional) })),
  };
}

/** Play a whole game with a strategy function (ctx, game) => action. */
export function autoplay(game, strategy) {
  while (!game.over) {
    let action = strategy(game.context(), game);
    const chk = game.check(action);
    if (!chk.ok) action = { stock: action.stock ?? null, legs: [] };
    if (!game.check(action).ok) action = { stock: null, legs: [] };
    game.play(action);
  }
  return game;
}
