// Engine unit tests: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";

import { normCdf, bsPrice, impliedVol, smileVol, tradePrice, intrinsic } from "../site/engine/options.js";
import { maxDrawdown, sharpe, sortino, xirr, cagr, dailyReturns, beta, stdev, mean } from "../site/engine/metrics.js";
import { buildMarket, realizedVol, sma, alignAsOf } from "../site/engine/market.js";
import { Game, RULES, autoplay, legalize } from "../site/engine/game.js";
import { rankStrategies } from "../site/engine/scoring.js";
import { runBenchmarks, STRATEGIES } from "../site/engine/strategies.js";
import { mulberry32 } from "../site/engine/rng.js";
import { debrief } from "../site/engine/coach.js";
import { encodeReplay, decodeReplay } from "../site/engine/replay.js";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

// ---------------------------------------------------------------- fixtures

function bizDates(n, start = "2019-01-01") {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Synthetic test market: `path(i)` gives the stock price on day i. */
function synthMarket(n, path, { rate = 0, vix = 20, spyPath } = {}) {
  const dates = bizDates(n);
  const rng = mulberry32(7);
  // SPY with ~16% realized vol so the IV ratio is well defined.
  let spy = 100;
  const spyClose = dates.map((_, i) => (spyPath ? spyPath(i) : (spy *= Math.exp(0.01 * (rng() - 0.5) * 3.5))));
  return buildMarket({
    stock: { symbol: "TEST", name: "Test", dates, close: dates.map((_, i) => path(i)) },
    spy: { dates, close: spyClose },
    vix: { dates, close: dates.map(() => vix) },
    irx: { dates, close: dates.map(() => rate * 100) },
  });
}

// A wiggly path (needs non-zero realized vol for IV).
const wiggle = (i) => 100 * (1 + 0.02 * Math.sin(i / 3)) * Math.exp(0.0003 * i);

// ---------------------------------------------------------------- options

test("normCdf matches reference values", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.9750021, 2e-7);
  close(normCdf(-1), 0.1586553, 2e-7);
  close(normCdf(3), 0.9986501, 2e-7);
});

test("Black-Scholes textbook values and put-call parity", () => {
  // Hull: S=100, K=100, T=1, r=5%, sigma=20% -> C=10.4506, P=5.5735
  close(bsPrice("C", 100, 100, 1, 0.05, 0.2), 10.4506, 2e-4);
  close(bsPrice("P", 100, 100, 1, 0.05, 0.2), 5.5735, 2e-4);
  for (const K of [80, 95, 100, 110, 130]) {
    const c = bsPrice("C", 100, K, 0.25, 0.03, 0.35);
    const p = bsPrice("P", 100, K, 0.25, 0.03, 0.35);
    close(c - p, 100 - K * Math.exp(-0.03 * 0.25), 1e-6, `parity K=${K}`);
  }
  assert.equal(bsPrice("C", 120, 100, 0, 0.05, 0.3), 20);
  assert.equal(bsPrice("P", 120, 100, 0, 0.05, 0.3), 0);
  assert.equal(intrinsic("P", 80, 100), 20);
});

test("ATM implied vol adds the index variance premium (measured at 0.88 x VIX) to stock variance", () => {
  // stock RV 30%, SPY RV 15%, VIX 18 -> sqrt(.09 + (0.88*.18)^2 - .0225)
  close(impliedVol(0.3, 0.15, 18), Math.sqrt(0.09 + (0.88 * 0.18) ** 2 - 0.0225), 1e-12);
  // SPY itself: at-the-money vol = 0.88 x VIX
  close(impliedVol(0.15, 0.15, 18), 0.88 * 0.18, 1e-12);
  // when realized index vol exceeds the VIX, the stock IV is floored at 75% of its RV
  close(impliedVol(0.3, 0.5, 20), 0.225, 1e-12);
  close(impliedVol(0.01, 0.15, 12), 0.08, 1e-12); // absolute floor
});

test("volatility smile: puts richer, calls cheaper, clipped", () => {
  close(smileVol(0.2, 1, 1.25), 0.2, 1e-12);
  close(smileVol(0.2, 0.95, 1.25), 0.2 * (1 - 1.25 * Math.log(0.95)), 1e-12);
  assert.ok(smileVol(0.2, 0.9, 3) > smileVol(0.2, 0.95, 3));
  assert.ok(smileVol(0.2, 1.1, 3) < smileVol(0.2, 1.05, 3));
  close(smileVol(0.2, 0.5, 3), 0.4, 1e-12); // clipped at 2x ATM
});

test("trade price adds/subtracts half-spread with a floor", () => {
  close(tradePrice(4, 100, "B"), 4.1, 1e-12);
  close(tradePrice(4, 100, "W"), 3.9, 1e-12);
  close(tradePrice(0.5, 100, "B"), 0.55, 1e-12); // min 5bp of spot
  assert.equal(tradePrice(0.01, 100, "W"), 0);
});

// ---------------------------------------------------------------- metrics

test("max drawdown finds the largest peak-to-trough", () => {
  const r = maxDrawdown([100, 120, 90, 95, 130, 65, 70]);
  close(r.mdd, 0.5, 1e-12);
  assert.equal(r.from, 4);
  assert.equal(r.to, 5);
  assert.equal(maxDrawdown([1, 2, 3]).mdd, 0);
});

test("Sharpe and Sortino match hand computation", () => {
  const rets = [0.01, -0.005, 0.002, 0.007, -0.012, 0.004];
  const rf = rets.map(() => 0.0001);
  const ex = rets.map((r) => r - 0.0001);
  const m = ex.reduce((a, b) => a + b) / ex.length;
  const sd = Math.sqrt(ex.reduce((a, b) => a + (b - m) ** 2, 0) / (ex.length - 1));
  close(sharpe(rets, rf), (m / sd) * Math.sqrt(252), 1e-12);
  const dd = Math.sqrt(ex.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / ex.length);
  close(sortino(rets, rf), (m / dd) * Math.sqrt(252), 1e-12);
});

test("XIRR and CAGR agree for a single deposit", () => {
  const flows = [{ date: "2020-01-01", amount: -100 }, { date: "2021-01-01", amount: 110 }];
  const expected = 1.1 ** (365 / 366) - 1; // 2020 is a leap year
  close(xirr(flows), expected, 1e-9);
  close(cagr(100, 110, "2020-01-01", "2021-01-01"), expected, 1e-12);
  assert.equal(xirr([{ date: "2020-01-01", amount: -100 }, { date: "2021-01-01", amount: 0 }]), -1);
});

test("XIRR handles multiple cash flows", () => {
  // -1000, +100 after 1y, +1100 after 2y => 10% exactly (365-day years).
  const flows = [
    { date: "2021-01-01", amount: -1000 },
    { date: "2022-01-01", amount: 100 },
    { date: "2023-01-01", amount: 1100 },
  ];
  close(xirr(flows), 0.1, 1e-9);
});

test("beta of a series against itself is 1, against 2x is 0.5", () => {
  const a = [0.01, -0.02, 0.015, 0.003, -0.007];
  close(beta(a, a), 1, 1e-12);
  close(beta(a, a.map((x) => 2 * x)), 0.5, 1e-12);
});

// ---------------------------------------------------------------- market

test("as-of alignment, realized vol and SMA", () => {
  assert.deepEqual(alignAsOf(["2020-01-02", "2020-01-03", "2020-01-06"], ["2020-01-02", "2020-01-06"], [1, 2]), [1, 1, 2]);
  assert.ok(Number.isNaN(alignAsOf(["2020-01-01"], ["2020-01-02"], [1])[0]));
  const flat = new Array(100).fill(50);
  assert.equal(realizedVol(flat, 63)[99], 0);
  const p = [100, 110, 99, 108.9, 98.01];
  const lr = [1, 2, 3, 4].map((i) => Math.log(p[i] / p[i - 1]));
  close(realizedVol(p, 4)[4], stdev(lr) * Math.sqrt(252), 1e-9);
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
});

// ---------------------------------------------------------------- game

function newGame(path, opts = {}) {
  const m = synthMarket(opts.n ?? 600, path, opts);
  return new Game(m, { startIdx: opts.startIdx ?? 250, turns: opts.turns ?? 12 });
}

test("buy and hold with zero rates tracks the stock minus one trade cost", () => {
  const g = newGame(wiggle);
  autoplay(g, STRATEGIES.buyHold.fn);
  const s0 = g.S[g.startIdx];
  const s1 = g.S[g.endIdx];
  const cost = RULES.stake * RULES.stockCostBps / 10000;
  const expected = (RULES.stake - cost) * (s1 / s0) + 0; // shares bought with stake; cost from cash
  // shares = stake/s0; cash = -cost; equity = stake/s0*s1 - cost
  // The $50 trade cost leaves a tiny debit that pays margin interest (< $1/yr).
  close(g.equity, (RULES.stake / s0) * s1 - cost, 1);
  assert.ok(Math.abs(g.equity - expected) < 100);
  assert.equal(g.over, true);
  assert.equal(g.curve.equity.length, 12 * 21 + 1);
});

test("cash earns the T-bill rate daily", () => {
  const g = newGame(wiggle, { rate: 0.0504 });
  autoplay(g, STRATEGIES.cash.fn);
  close(g.equity, RULES.stake * (1 + 0.0504 / 252) ** (12 * 21), 1e-6);
  const res = g.results();
  assert.equal(res.sharpe, 0, "T-bills have zero excess return");
  close(res.maxDrawdown, 0, 1e-12);
});

test("prices are rebased to 100 at the start", () => {
  const g = newGame((i) => 3 * wiggle(i));
  close(g.S[g.startIdx], 100, 1e-9);
});

test("written calls must be covered and puts cash-secured", () => {
  const g = newGame(wiggle);
  let c = g.check({ stock: 0, legs: [{ side: "W", type: "C", strike: 105, notional: 0.5 }] });
  assert.equal(c.ok, false);
  c = g.check({ stock: 1, legs: [{ side: "W", type: "C", strike: 105, notional: 1 }] });
  assert.equal(c.ok, true);
  c = g.check({ stock: 1, legs: [{ side: "W", type: "C", strike: 105, notional: 1.2 }] });
  assert.equal(c.ok, false);
  c = g.check({ stock: 1, legs: [{ side: "W", type: "P", strike: 95, notional: 0.5 }] });
  assert.equal(c.ok, false, "no free equity when 100% long");
  c = g.check({ stock: 0, legs: [{ side: "W", type: "P", strike: 100, notional: 1 }] });
  assert.equal(c.ok, true);
  c = g.check({ stock: 0, legs: [{ side: "W", type: "P", strike: 110, notional: 1.2 }] });
  assert.equal(c.ok, false, "strike value 132% of equity > cash");
  c = g.check({ stock: 0.5, legs: [{ side: "W", type: "P", strike: 100, notional: 0.5 }] });
  assert.equal(c.ok, true);
});

test("exposure and borrowing limits", () => {
  const g = newGame(wiggle);
  assert.equal(g.check({ stock: 1.5, legs: [] }).ok, true);
  assert.equal(g.check({ stock: 1.6, legs: [] }).ok, false);
  assert.equal(g.check({ stock: -1, legs: [] }).ok, true);
  assert.equal(g.check({ stock: -1.1, legs: [] }).ok, false);
  // 150% long uses all borrowing; buying puts on top would exceed it.
  assert.equal(g.check({ stock: 1.5, legs: [{ side: "B", type: "P", strike: 95, notional: 1 }] }).ok, false);
  assert.equal(g.check({ stock: 1, legs: [{ side: "B", type: "P", strike: 95, notional: 1 }] }).ok, true);
  assert.equal(g.check({ stock: 0, legs: new Array(5).fill({ side: "B", type: "C", strike: 100, notional: 0.1 }) }).ok, false);
  assert.equal(g.check({ stock: 0, legs: [{ side: "B", type: "C", strike: 97, notional: 0.1 }] }).ok, false);
});

test("a long call settles at intrinsic value at turn end", () => {
  // Flat-ish history (for IV), then a ramp to +20% during the first turn.
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : 100 * (1 + 0.2 * Math.min(1, (i - start) / 21)));
  const g = newGame(path, { startIdx: start, turns: 2 });
  const q = g.quotes();
  const row = q.rows.find((r) => r.strike === 100);
  const n = (0.5 * RULES.stake) / 100;
  g.play({ stock: 0, legs: [{ side: "B", type: "C", strike: 100, notional: 0.5 }] });
  const t = g.log[0];
  close(t.premiumFlow, -n * row.C.ask, 1e-6);
  close(t.optionPnl, n * 20 - n * row.C.ask, 1e-6);
  close(g.equity, RULES.stake + n * 20 - n * row.C.ask, 1e-6);
  assert.equal(g.legs.length, 0);
});

test("written covered call caps the upside", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : 100 * (1 + 0.3 * Math.min(1, (i - start) / 21)));
  const g = newGame(path, { startIdx: start, turns: 1 });
  const bid = g.quotes().rows.find((r) => r.strike === 105).C.bid;
  g.play({ stock: 1, legs: [{ side: "W", type: "C", strike: 105, notional: 1 }] });
  const n = RULES.stake / 100;
  const cost = RULES.stake * RULES.stockCostBps / 10000;
  // Stock gains 30, call pays out 25 => net 5/share plus premium.
  close(g.equity, RULES.stake - cost + n * 5 + n * bid, 0.5);
});

test("margin call liquidates a levered long after a crash", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : i < start + 5 ? 100 : 40);
  const g = newGame(path, { startIdx: start, turns: 3 });
  g.play({ stock: 1.5, legs: [] });
  assert.equal(g.events[0].kind, "margin");
  assert.equal(g.shares, 0);
  assert.equal(g.busted, false);
  // Equity ≈ 100k - 150k*0.6 - costs
  // plus ~5 days of margin interest on the $50k debit at 1.5%
  close(g.equity, 100000 - 90000 - 75 - 60000 * 5e-4 - 50075 * 0.015 / 252 * 5, 0.5);
  assert.equal(g.over, false);
});

test("a short squeeze can bust the account", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : i < start + 3 ? 100 : 260);
  const g = newGame(path, { startIdx: start, turns: 3 });
  g.play({ stock: -1, legs: [] });
  assert.equal(g.busted, true);
  assert.equal(g.over, true);
  assert.equal(g.equity, 0);
  const res = g.results();
  assert.equal(res.irr, -1);
  close(res.maxDrawdown, 1, 1e-12);
});

test("short stock pays borrow and profits when the stock falls", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : 100 - 10 * Math.min(1, (i - start) / 21));
  const g = newGame(path, { startIdx: start, turns: 1 });
  g.play({ stock: -1, legs: [] });
  assert.ok(g.attr.borrow > 0);
  const cost = RULES.stake * RULES.stockCostBps / 10000;
  close(g.equity, RULES.stake - cost + 1000 * 10 - g.attr.borrow, 1e-6);
});

test("games are deterministic and benchmarks run", () => {
  const actions = [{ stock: 1, legs: [] }, { stock: 0.5, legs: [{ side: "B", type: "P", strike: 95, notional: 0.5 }] }, { stock: null, legs: [] }];
  const run = () => {
    const g = newGame(wiggle, { turns: 3 });
    for (const a of actions) g.play(a);
    return g.results();
  };
  assert.deepEqual(run(), run());
  const m = synthMarket(600, wiggle);
  const b = runBenchmarks(m, { startIdx: 250, turns: 12 }, null);
  assert.equal(b.length, 5);
  for (const x of b) assert.ok(Number.isFinite(x.results.finalValue));
});

test("coach debrief produces notes", () => {
  const g = newGame(wiggle, { turns: 6 });
  autoplay(g, () => ({ stock: -0.5, legs: [{ side: "B", type: "C", strike: 105, notional: 0.2 }] }));
  const notes = debrief(g, []);
  assert.ok(notes.length >= 3);
  assert.ok(notes.some((n) => n.title === "Shorting"));
});

test("replay encoding round-trips", () => {
  const cfg = { v: 1, sym: "NVDA", end: "2026-10-30", startTurn: 12, turns: 12, blind: true, seed: 123 };
  const log = [{ stock: 1, legs: [] }, { stock: null, legs: [{ side: "W", type: "C", strike: 105, notional: 1 }] }];
  const s = encodeReplay(cfg, log);
  assert.ok(!s.includes("NVDA"));
  const back = decodeReplay(s);
  assert.deepEqual(back.cfg, cfg);
  assert.deepEqual(back.actions, log);
});

// ---------------------------------------------------------------- review regressions

test("options cannot bypass the leverage caps", () => {
  const g = newGame(wiggle);
  const four = new Array(4).fill({ side: "B", type: "C", strike: 90, notional: 2 });
  assert.equal(g.check({ stock: 0, legs: four }).ok, false, "4 x 200% calls rejected");
  assert.equal(g.check({ stock: 0, legs: [{ side: "B", type: "C", strike: 100, notional: 1.5 }, { side: "B", type: "P", strike: 100, notional: 0.6 }] }).ok, false, "total notional > 200%");
  assert.equal(g.check({ stock: 0, legs: [{ side: "B", type: "C", strike: 100, notional: 1 }, { side: "B", type: "P", strike: 100, notional: 1 }] }).ok, true, "straddle on 100% is fine");
  const c = g.check({ stock: 1, legs: [{ side: "B", type: "C", strike: 90, notional: 1 }] });
  assert.equal(c.ok, false, "stock 100% + deep ITM calls exceeds 150% net");
  assert.ok(c.errors.some((e) => e.includes("Net long exposure")));
  assert.equal(g.check({ stock: -1, legs: [{ side: "B", type: "P", strike: 110, notional: 1 }] }).ok, false, "short 100% + ITM puts exceeds -100% net");
  assert.equal(g.check({ stock: 1, legs: [{ side: "B", type: "P", strike: 95, notional: 1 }] }).ok, true, "protective put lowers net exposure");
});

test("written puts are secured by cash left after the whole order", () => {
  const g = newGame(wiggle);
  // 50% long leaves 50% cash: enough to secure puts on 50%, unless the order spends it on calls.
  const put = { side: "W", type: "P", strike: 100, notional: 0.5 };
  assert.equal(g.check({ stock: 0.5, legs: [put] }).ok, true);
  assert.equal(g.check({ stock: 0.5, legs: [put, { side: "B", type: "C", strike: 100, notional: 0.5 }] }).ok, false);
  // Short-sale proceeds don't secure puts: only the account's own cash does.
  assert.equal(g.check({ stock: -1, legs: [{ side: "W", type: "P", strike: 95, notional: 0.9 }] }).ok, true);
  assert.equal(g.check({ stock: -1, legs: [{ side: "W", type: "P", strike: 100, notional: 1.2 }] }).ok, false);
});

test("holding a drifted position is always allowed; adding borrowing is not", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : 100 - 8 * Math.min(1, (i - start) / 21));
  const g = newGame(path, { startIdx: start, turns: 3 });
  g.play({ stock: 1.5, legs: [] });
  assert.ok(g.cash < -0.5 * g.equity, "borrowing drifted above 50%");
  assert.equal(g.check({ stock: null, legs: [] }).ok, true, "keep current is allowed");
  assert.equal(g.check({ stock: null, legs: [{ side: "B", type: "P", strike: 95, notional: 0.5 }] }).ok, false, "buying puts on more margin is not");
  assert.equal(g.check({ stock: 1.2, legs: [] }).ok, true, "reducing is allowed");
});

test("maintenance margin is also checked on the expiry close", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : i < start + 21 ? 100 : 170);
  const g = newGame(path, { startIdx: start, turns: 3 });
  g.play({ stock: -1, legs: [] });
  assert.equal(g.events.length, 1);
  assert.equal(g.events[0].kind, "margin");
  assert.equal(g.events[0].idx, start + 21);
  assert.equal(g.shares, 0);
});

test("a bust pads the curve to the window end and has no Sharpe", () => {
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : i < start + 3 ? 100 : 260);
  const g = newGame(path, { startIdx: start, turns: 3 });
  g.play({ stock: -1, legs: [] });
  assert.equal(g.curve.equity.length, 3 * 21 + 1);
  assert.equal(g.curve.idx[g.curve.idx.length - 1], g.endIdx);
  const res = g.results();
  assert.ok(Number.isNaN(res.sharpe));
  assert.equal(res.irr, -1);
  const ranked = rankStrategies([{ key: "you", results: res }, { key: "cash", results: { sharpe: 0, maxDrawdown: 0, irr: 0.03 } }]);
  assert.equal(ranked[ranked.length - 1].key, "you");
});

test("autopilot taking over mid-game follows its own rule", () => {
  // T-bills after a long month -> flat.
  let g = newGame(wiggle, { turns: 6 });
  g.play({ stock: 1, legs: [] });
  autoplay(g, STRATEGIES.cash.fn);
  assert.ok(g.log.slice(1).every((t) => Math.abs(t.exposure) < 1e-9));
  // Buy & hold after a short month -> buys 100% once.
  g = newGame(wiggle, { turns: 6 });
  g.play({ stock: -1, legs: [] });
  autoplay(g, STRATEGIES.buyHold.fn);
  close(g.log[1].exposure, 1, 1e-9);
  // Never throws after a levered losing month.
  const start = 250;
  const path = (i) => (i <= start ? wiggle(i) / wiggle(start) * 100 : 100 - 6 * Math.min(1, (i - start) / 21));
  g = newGame(path, { startIdx: start, turns: 4 });
  g.play({ stock: 1.5, legs: [] });
  for (const k of Object.keys(STRATEGIES)) {
    const h = newGame(path, { startIdx: start, turns: 4 });
    h.play({ stock: 1.5, legs: [] });
    assert.doesNotThrow(() => autoplay(h, STRATEGIES[k].fn), k);
    assert.equal(h.over, true);
  }
  assert.ok(legalize(g, { stock: 1.5, legs: [] }));
});

test("overall ranking uses Sharpe, drawdown and IRR together", () => {
  const rows = rankStrategies([
    { key: "riskless", results: { sharpe: -0.98, maxDrawdown: 0.006, irr: 0.037 } },
    { key: "crash", results: { sharpe: -0.53, maxDrawdown: 0.84, irr: -0.25 } },
    { key: "market", results: { sharpe: 0.54, maxDrawdown: 0.245, irr: 0.122 } },
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["market", "riskless", "crash"]);
  assert.deepEqual(rows[1].ranks, { sharpe: 3, maxDrawdown: 1, irr: 2 });
});
