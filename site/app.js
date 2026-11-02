// Blind Tape: UI controller. All market logic lives in engine/ (pure, unit-tested).
import { buildMarket, firstUsableIndex } from "./engine/market.js";
import { Game, RULES, normalizeAction, legalize } from "./engine/game.js";
import { rankStrategies } from "./engine/scoring.js";
import { STRATEGIES, runBenchmarks } from "./engine/strategies.js";
import { debrief } from "./engine/coach.js";
import { encodeReplay, decodeReplay } from "./engine/replay.js";
import { mulberry32, pick, randInt, newSeed } from "./engine/rng.js";
import { drawdownSeries } from "./engine/metrics.js";
import { loadMeta, loadBundle } from "./ui/data.js";
import { makeChart, rebuildAll } from "./ui/charts.js";
import { money, pct, num, signClass, fmtDate, fmtMonthYear, isoToSec } from "./ui/format.js";

const $ = (id) => document.getElementById(id);
const TD = RULES.turnDays;
const STRAT_COLORS = { you: "--s1", buyHold: "--s2", spy: "--s3", coveredCall: "--s4", protectivePut: "--s5", trend200: "--s6" };

const S = {
  meta: null,
  cfg: null,
  game: null,
  market: null,
  spyMarket: null,
  actions: [],
  legs: [],
  stockTarget: null, // null = keep current share count
  charts: {},
  benchmarks: null,
  replay: false,
  lastToast: "",
};

// ------------------------------------------------------------------ boot

init().catch((e) => fatal(e));

async function init() {
  initTheme();
  wireStatic();
  window.addEventListener("hashchange", route);
  try {
    S.meta = await loadMeta();
  } catch (e) {
    $("homeData").textContent = "Couldn't load market data. Please refresh.";
    throw e;
  }
  renderHomeMeta();
  renderDataPage();
  route();
}

function fatal(e, { quiet = false } = {}) {
  if (!quiet) console.error(e);
  const b = $("staleBanner");
  b.hidden = false;
  b.textContent = `Something went wrong: ${e.message}`;
}

// ------------------------------------------------------------------ theme

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("bt-theme"); } catch { /* storage blocked */ }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  $("themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("bt-theme", next); } catch { /* ignore */ }
    rebuildAll();
  });
}

// ------------------------------------------------------------------ routing

function show(screen) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== `screen-${screen}`;
  for (const a of document.querySelectorAll(".nav a")) {
    const n = a.dataset.nav;
    a.classList.toggle("active", n === screen || (n === "home" && ["game", "results"].includes(screen)));
  }
  window.scrollTo(0, 0);
}

async function route() {
  const h = location.hash || "#/";
  if (h.startsWith("#/replay/")) {
    await openReplay(h.slice("#/replay/".length));
    return;
  }
  if (h === "#/play" && S.game && !S.game.over) { show("game"); renderGame(); return; }
  if (h === "#/play" && S.game && S.game.over) { location.hash = "#/results"; return; }
  if (h === "#/results" && S.game && S.game.over) { show("results"); renderResults(); return; }
  if (h === "#/how") { show("how"); return; }
  if (h === "#/data") { show("data"); return; }
  show("home");
  renderResume();
}

function renderResume() {
  const card = $("resumeCard");
  const active = S.game && !S.game.over;
  card.hidden = !active;
  if (active) $("resumeText").textContent = `Month ${S.game.turn + 1} of ${S.game.turns} · equity ${money(S.game.equity)}`;
}

// ------------------------------------------------------------------ home

function wireStatic() {
  $("startFull").addEventListener("click", () => newGame("full"));
  $("resumeBtn").addEventListener("click", () => { location.hash = "#/play"; });
  $("startQuick").addEventListener("click", () => newGame("quick"));
  $("optTicker").addEventListener("change", (e) => {
    if (e.target.value) $("optBlind").checked = false;
  });
  $("playAgain").addEventListener("click", () => { location.hash = "#/"; });
  $("copyReplay").addEventListener("click", copyReplay);

  $("stockSlider").addEventListener("input", (e) => {
    S.stockTarget = Number(e.target.value) / 100;
    updateTicket();
  });
  for (const b of document.querySelectorAll(".quick-btns button")) {
    b.addEventListener("click", () => {
      S.stockTarget = Number(b.dataset.x) / 100;
      $("stockSlider").value = b.dataset.x;
      updateTicket();
    });
  }
  $("addLeg").addEventListener("click", () => {
    addLeg($("legSide").value, $("legType").value, Number($("legStrike").value), Number($("legSize").value));
  });
  $("nextTurn").addEventListener("click", nextTurn);
  $("autoRun").addEventListener("click", runAutopilot);
  const sel = $("autoStrat");
  for (const [k, v] of Object.entries(STRATEGIES)) sel.add(new Option(v.short, k));
  const descr = () => { $("autoDesc").textContent = STRATEGIES[sel.value].label; };
  sel.addEventListener("change", descr);
  descr();
  for (const k of RULES.strikes) $("legStrike").add(new Option(`${k}% strike`, k, k === 100, k === 100));
}

function renderHomeMeta() {
  const m = S.meta;
  const sel = $("optTicker");
  for (const p of poolInfo()) sel.add(new Option(`${p.symbol} (${p.name})`, p.symbol));
  const stale = isStale(m);
  $("homeData").innerHTML = `${poolInfo().length} stocks · real daily closes through <strong>${fmtDate(m.as_of)}</strong> · refreshed automatically every weekday · <a href="#/data">data status</a>`;
  if (stale) {
    const b = $("staleBanner");
    b.hidden = false;
    b.textContent = `Heads up: the latest market data is from ${fmtDate(m.as_of)}. The daily refresh may have failed; the game still works on the last good data.`;
  }
}

function poolInfo() {
  const m = S.meta;
  const info = m.pool_info || m.pool.map((s) => ({ symbol: s, name: s, regime: "" }));
  return info.filter((p) => m.series[p.symbol.replace("^", "")]);
}

function isStale(m) {
  if (m.stale) return true;
  const ageDays = (Date.now() - Date.parse(m.as_of + "T21:00:00Z")) / 86400000;
  return ageDays > 6;
}

// ------------------------------------------------------------------ game setup

async function newGame(mode) {
  const seed = newSeed();
  const rng = mulberry32(seed);
  const pool = poolInfo().map((p) => p.symbol);
  const chosen = $("optTicker").value;
  const sym = chosen || pick(rng, pool);
  const fullTurns = (S.meta.game_years || 5) * 12;
  const turns = mode === "quick" ? 12 : fullTurns;
  const startTurn = mode === "quick" ? randInt(rng, 0, fullTurns - turns + 1) : 0;
  const cfg = { v: 1, sym, end: S.meta.as_of, fullTurns, startTurn, turns, blind: chosen ? false : $("optBlind").checked, seed, mode };
  try {
    await setupGame(cfg);
  } catch (e) {
    fatal(e);
    return;
  }
  S.replay = false;
  location.hash = "#/play";
  if (location.hash === "#/play") { show("game"); renderGame(true); }
}

async function setupGame(cfg) {
  const bundle = await loadBundle(cfg.sym);
  const market = buildMarket(bundle, { endDate: cfg.end });
  const spyMarket = buildMarket({ stock: bundle.spy, spy: bundle.spy, vix: bundle.vix, irx: bundle.irx }, { endDate: cfg.end });
  const fullStart = market.last - cfg.fullTurns * TD;
  const startIdx = fullStart + cfg.startTurn * TD;
  if (fullStart < firstUsableIndex(market)) throw new Error(`Not enough history for ${cfg.sym}.`);
  S.cfg = cfg;
  S.market = market;
  S.spyMarket = spyMarket;
  S.game = new Game(market, { startIdx, turns: cfg.turns });
  S.actions = [];
  S.legs = [];
  S.stockTarget = null;
  S.benchmarks = null;
  S.lastToast = "";
  for (const k of Object.keys(S.charts)) { S.charts[k].destroy(); delete S.charts[k]; }
  document.querySelector(".autopilot").open = false;
}

// ------------------------------------------------------------------ game screen

const realPx = (x) => (S.cfg.blind ? x : x / S.game.base);

function monthLabelFor(x) {
  const g = S.game;
  const idx = Math.round(g.startIdx + x * TD);
  if (!S.cfg.blind && S.market.dates[idx]) return fmtDate(S.market.dates[idx]);
  const m = Math.round(x * 10) / 10;
  return m <= 0 ? `${m.toFixed(1)} mo (before start)` : `Month ${m.toFixed(1)}`;
}

function renderGame(fresh = false) {
  const g = S.game;
  const ctx = g.context();
  const totalRet = g.equity / RULES.stake - 1;
  $("sTurn").textContent = `${Math.min(ctx.turn + 1, g.turns)} of ${g.turns}`;
  $("sEquity").textContent = money(g.equity);
  $("sReturn").textContent = pct(totalRet, 1, true);
  $("sReturn").className = `stat-value ${signClass(totalRet)}`;
  $("sExposure").textContent = pct(ctx.exposure, 0);
  $("sCash").textContent = money(ctx.cash);
  $("sIv").textContent = pct(ctx.iv, 0);
  const toast = $("turnToast");
  toast.hidden = !S.lastToast;
  toast.innerHTML = S.lastToast;

  if (S.cfg.blind) {
    $("priceTitle").textContent = "Mystery stock";
    $("priceSub").textContent = "Price rebased to 100 at the start · gray line: 200-day average · x-axis: months from the start";
  } else {
    const p = poolInfo().find((q) => q.symbol === S.cfg.sym);
    $("priceTitle").textContent = `${p ? p.name : S.cfg.sym} (${S.cfg.sym})`;
    $("priceSub").textContent = `Adjusted price, USD · ${fmtDate(S.market.dates[g.idx])} · gray line: 200-day average`;
  }

  // Price history: up to one year before the start, through today.
  const from = Math.max(0, g.startIdx - 252);
  const xs = [];
  const px = [];
  const ma = [];
  for (let d = from; d <= g.idx; d++) {
    xs.push((d - g.startIdx) / TD);
    px.push(realPx(g.S[d]));
    const sm = S.market.sma200[d] * g.base;
    ma.push(Number.isFinite(sm) ? realPx(sm) : null);
  }
  const priceFmt = (v) => (S.cfg.blind ? v.toFixed(1) : `$${v.toFixed(2)}`);
  const xFmt = (v) => (S.cfg.blind ? `${v > 0 ? "+" : ""}${v}` : (() => {
    const d = S.market.dates[Math.round(g.startIdx + v * TD)];
    return d ? fmtMonthYear(d) : "";
  })());
  if (!S.charts.price) {
    S.charts.price = makeChart({
      el: $("priceChart"), height: 300, xFmt, yFmt: priceFmt, xLabel: "When", xLabelFmt: monthLabelFor, xIncrs: [1, 2, 3, 6, 12, 24],
      series: [
        { label: "Price", colorVar: "--s1", width: 2, fmt: priceFmt },
        { label: "200-day average", colorVar: "--ref", width: 1.5, fmt: priceFmt },
      ],
      data: [xs, px, ma],
    });
  } else {
    S.charts.price.update([xs, px, ma]);
  }

  // Equity vs holding the stock.
  const ex = [];
  const eq = [];
  const hold = [];
  g.curve.idx.forEach((d, i) => {
    ex.push((d - g.startIdx) / TD);
    eq.push(g.curve.equity[i]);
    hold.push((RULES.stake * g.S[d]) / g.S[g.startIdx]);
  });
  const mFmt = (v) => money(v, { compact: true });
  if (!S.charts.equity) {
    S.charts.equity = makeChart({
      el: $("equityChart"), height: 220, xFmt: (v) => (S.cfg.blind ? `${v}` : xFmt(v)), yFmt: mFmt, xLabel: "When", xLabelFmt: monthLabelFor, xIncrs: [1, 2, 3, 6, 12, 24],
      xRange: () => [0, Math.max(1, S.game.turn)],
      series: [
        { label: "You", colorVar: "--s1", width: 2, fmt: (v) => money(v) },
        { label: "Holding the stock", colorVar: "--s2", width: 2, fmt: (v) => money(v) },
      ],
      data: [ex, eq, hold],
    });
  } else {
    S.charts.equity.update([ex, eq, hold]);
  }

  // Reset the ticket for this month.
  if (fresh || S.stockTarget === null) {
    const cur = Math.max(-100, Math.min(150, Math.round((ctx.exposure * 100) / 5) * 5));
    $("stockSlider").value = String(cur);
  }
  renderQuotes();
  updateTicket();
}

function renderQuotes() {
  const g = S.game;
  const q = g.quotes();
  const tb = $("quotesTable").querySelector("tbody");
  tb.innerHTML = "";
  const f = (v) => realPx(v).toFixed(2);
  for (const row of q.rows) {
    const tr = document.createElement("tr");
    const kLabel = S.cfg.blind ? `${row.strike}%` : `${row.strike}% ($${realPx(row.K).toFixed(2)})`;
    tr.innerHTML = `<td class="k">${kLabel}</td><td class="ivc">${pct(row.iv, 0)}</td>`;
    for (const type of ["C", "P"]) {
      for (const side of ["W", "B"]) {
        const td = document.createElement("td");
        if (row.strike === 100) td.className = "atm";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "px";
        b.textContent = f(side === "W" ? row[type].bid : row[type].ask);
        b.title = `${side === "B" ? "Buy" : "Write (sell)"} the ${row.strike}% ${type === "C" ? "call" : "put"} at ${b.textContent}`;
        b.setAttribute("aria-label", b.title);
        b.addEventListener("click", () => addLeg(side, type, row.strike, Number($("legSize").value)));
        td.appendChild(b);
        tr.appendChild(td);
      }
    }
    tb.appendChild(tr);
  }
  $("optMeta").textContent = `At-the-money IV ${pct(q.iv, 1)} · T-bill ${pct(q.r, 2)} · expire in ${TD} trading days`;
}

function addLeg(side, type, strike, notional) {
  if (S.legs.length >= RULES.maxLegs) {
    S.legNote = `You can trade at most ${RULES.maxLegs} option legs a month. Remove one first.`;
    updateTicket();
    return;
  }
  S.legNote = "";
  S.legs.push({ side, type, strike, notional });
  updateTicket();
}

function currentAction() {
  return { stock: S.stockTarget, legs: S.legs.slice() };
}

function updateTicket() {
  const g = S.game;
  if (!g) return;
  const out = $("stockOut");
  if (S.stockTarget === null) {
    out.textContent = `Keep current (${pct(g.exposure(), 0)})`;
  } else {
    out.textContent = `Target ${pct(S.stockTarget, 0)}`;
  }
  const list = $("legsList");
  list.innerHTML = "";
  S.legs.forEach((l, i) => {
    const li = document.createElement("li");
    const what = `${l.side === "B" ? "Buy" : "Write"} ${l.strike}%-strike ${l.type === "C" ? "calls" : "puts"}, size ${pct(l.notional, 0)} of equity`;
    li.innerHTML = `<span>${what}</span>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove: ${what}`);
    rm.textContent = "×";
    rm.addEventListener("click", () => { S.legs.splice(i, 1); S.legNote = ""; updateTicket(); });
    li.appendChild(rm);
    list.appendChild(li);
  });

  const chk = g.check(currentAction());
  const p = chk.preview;
  const S0 = g.S[g.idx];
  const stockTrade = (p.shares - g.shares) * S0;
  const prem = p.legs.reduce((s, l) => s + (l.side === "W" ? 1 : -1) * l.n * l.px, 0);
  const rows = [];
  rows.push(["Stock trade", Math.abs(stockTrade) < 1 ? "none" : `${stockTrade > 0 ? "buy" : "sell"} ${money(Math.abs(stockTrade))}`]);
  if (p.legs.length) rows.push([prem >= 0 ? "Option premium received" : "Option premium paid", money(Math.abs(prem))]);
  if (p.costs > 0.5 || p.spread > 0.5) rows.push(["Trading costs + spread", money(p.costs + p.spread)]);
  rows.push(["Cash after orders", money(p.cash)]);
  rows.push(["Stock position after", pct((p.shares * S0) / g.equity, 0)]);
  if (p.legs.length) rows.push(["Net exposure incl. option delta", pct(p.netExp, 0)]);
  $("preview").innerHTML = rows.map(([k, v]) => `<span>${k}</span><span class="v">${v}</span>`).join("");
  const errs = $("errors");
  errs.innerHTML = [...chk.errors, ...(S.legNote ? [S.legNote] : [])].map((e) => `<li>${e}</li>`).join("");
  $("nextTurn").disabled = !chk.ok || S.busy;
  $("nextTurn").textContent = g.turn + 1 >= g.turns ? "Finish & reveal ▸" : "Next month ▸";
}

function nextTurn() {
  const g = S.game;
  if (!g || g.over || S.busy) return;
  const action = currentAction();
  const chk = g.check(action);
  if (!chk.ok) { updateTicket(); return; }
  S.busy = true;
  setTimeout(() => { S.busy = false; if (S.game && !S.game.over) updateTicket(); }, 350);
  const before = g.equity;
  const t = g.play(action);
  S.actions.push(normalizeAction(action));
  S.legs = [];
  S.legNote = "";
  S.stockTarget = null;
  const you = (t.equityEnd ?? g.equity) / before - 1;
  let msg = `<strong>Month ${t.turn + 1}:</strong> stock ${pct(t.stockReturn, 1, true)} · you ${pct(you, 1, true)}`;
  if (t.action.legs.length) msg += ` · options ${t.optionPnl >= 0 ? "+" : "−"}${money(Math.abs(t.optionPnl))}`;
  if (t.marginCall) msg += " · <strong>margin call</strong>: positions were liquidated";
  if (g.busted) msg += " · <strong>account wiped out</strong>";
  S.lastToast = msg;
  if (g.over) finish();
  else renderGame();
}

function runAutopilot() {
  const key = $("autoStrat").value;
  const fn = STRATEGIES[key].fn;
  const g = S.game;
  const state = { first: true };
  try {
    while (!g.over) {
      const a = legalize(g, fn(g.context(), g, state));
      state.first = false;
      if (!a) throw new Error("The autopilot couldn't find a legal order.");
      g.play(a);
      S.actions.push(a);
    }
  } catch (e) {
    fatal(e);
    renderGame();
    return;
  }
  finish();
}

function finish() {
  const g = S.game;
  S.benchmarks = runBenchmarks(S.market, { startIdx: g.startIdx, turns: g.turns }, S.spyMarket);
  if (location.hash === "#/results") { show("results"); renderResults(); }
  else location.hash = "#/results";
}

// ------------------------------------------------------------------ results

function renderResults() {
  const g = S.game;
  const cfg = S.cfg;
  const res = g.results();
  if (!S.benchmarks) S.benchmarks = runBenchmarks(S.market, { startIdx: g.startIdx, turns: g.turns }, S.spyMarket);
  const benches = S.benchmarks;
  const bh = benches.find((b) => b.key === "buyHold").results;
  const p = poolInfo().find((q) => q.symbol === cfg.sym) || { name: cfg.sym, regime: "" };
  const d0 = S.market.dates[g.startIdx];
  const d1 = res.dates[res.dates.length - 1];

  $("revealEyebrow").textContent = S.replay ? "Replay" : cfg.blind ? "The tape is revealed" : "Game over";
  $("revealTitle").textContent = `${cfg.blind ? "It was " : ""}${p.name} (${cfg.sym})`;
  $("revealSub").textContent = `${fmtDate(d0)} to ${fmtDate(d1)} · ${g.turns} months${p.regime ? ` · ${p.regime}` : ""}. The stock returned ${pct(bh.totalReturn + 0, 0, true)} if simply held; you returned ${pct(res.totalReturn, 0, true)}.${g.busted ? " Your account was wiped out." : ""}`;

  $("tSharpe").textContent = res.busted ? "bust" : num(res.sharpe);
  $("tSharpeSub").textContent = `Buy & hold: ${num(bh.sharpe)}`;
  $("tMdd").textContent = pct(-res.maxDrawdown, 1);
  $("tMddSub").textContent = `Buy & hold: ${pct(-bh.maxDrawdown, 1)}`;
  $("tIrr").textContent = pct(res.irr, 1, true);
  $("tIrrSub").textContent = `Buy & hold: ${pct(bh.irr, 1, true)}`;
  $("tFinal").textContent = money(res.finalValue);
  $("tFinalSub").textContent = `from $100,000 (${pct(res.totalReturn, 0, true)})`;

  // Scorecard: ranked on all three judged metrics (Sharpe, max drawdown, IRR).
  const rows = rankStrategies([{ key: "you", short: "You", label: "You", results: res }, ...benches]);
  const you = rows.find((r) => r.key === "you");
  $("tRank").textContent = `${you.overall} of ${rows.length}`;
  $("tRankSub").textContent = `Sharpe #${you.ranks.sharpe} · drawdown #${you.ranks.maxDrawdown} · IRR #${you.ranks.irr}`;
  const tb = $("scoreTable").querySelector("tbody");
  const sharpeTxt = (x) => (x.busted ? "bust" : num(x.sharpe));
  const sup = (n) => `<sup class="rk">#${n}</sup>`;
  tb.innerHTML = rows.map((r) => {
    const x = r.results;
    const c = STRAT_COLORS[r.key];
    const sw = c ? `<span class="key" style="background:var(${c})"></span>` : `<span class="key"></span>`;
    const name = r.key === "you" ? "You" : `<span class="lbl-long">${r.label}</span><span class="lbl-short">${r.short}</span>`;
    return `<tr class="${r.key === "you" ? "you" : ""}"><td class="num rank">${r.overall}</td><td class="name">${sw}${name}</td>
      <td class="num">${sharpeTxt(x)}${sup(r.ranks.sharpe)}</td><td class="num">${pct(-x.maxDrawdown, 1)}${sup(r.ranks.maxDrawdown)}</td>
      <td class="num">${pct(x.irr, 1, true)}${sup(r.ranks.irr)}</td>
      <td class="num opt">${money(x.finalValue)}</td><td class="num opt ${signClass(x.totalReturn)}">${pct(x.totalReturn, 1, true)}</td>
      <td class="num opt">${x.busted ? "–" : num(x.sortino)}</td><td class="num opt">${pct(x.vol, 1)}</td><td class="num opt">${num(x.beta)}</td></tr>`;
  }).join("");

  // Equity curves (time axis)
  const xs = res.dates.map(isoToSec);
  const lines = [{ key: "you", label: "You", eq: g.curve.equity }];
  for (const b of benches) if (STRAT_COLORS[b.key]) lines.push({ key: b.key, label: b.short, eq: b.game.curve.equity });
  for (const k of ["resEquity", "resDd", "resExp"]) if (S.charts[k]) { S.charts[k].destroy(); delete S.charts[k]; }
  const dateLabel = (v) => fmtDate(new Date(v * 1000).toISOString().slice(0, 10));
  const allEq = lines.flatMap((l) => l.eq).filter((v) => v > 0);
  const useLog = Math.max(...allEq) / Math.min(...allEq) > 4;
  $("resEquitySub").textContent = `${useLog ? "Log scale" : "Linear scale"} · click a legend entry to hide it · hover for values`;
  S.charts.resEquity = makeChart({
    el: $("resEquityChart"), height: 320, xTime: true, yLog: useLog, yFmt: (v) => money(v, { compact: true }), ySize: 64,
    xLabel: "Date", xLabelFmt: dateLabel,
    series: lines.map((l) => ({ label: l.label, colorVar: STRAT_COLORS[l.key], width: l.key === "you" ? 2.5 : 1.75, fmt: (v) => money(v) })),
    data: [xs, ...lines.map((l) => l.eq.map((v) => Math.max(v, 1)))],
  });

  const dds = [drawdownSeries(g.curve.equity), drawdownSeries(benches.find((b) => b.key === "buyHold").game.curve.equity)];
  S.charts.resDd = makeChart({
    el: $("resDdChart"), height: 220, xTime: true, yFmt: (v) => pct(v, 0), xLabel: "Date", xLabelFmt: dateLabel,
    yRange: (u, min) => [Math.min(-0.05, min * 1.05), 0],
    series: [
      { label: "You", colorVar: "--s1", fillAlpha: 0.1, fmt: (v) => pct(v, 1) },
      { label: "Buy & hold", colorVar: "--s2", fillAlpha: 0.1, fmt: (v) => pct(v, 1) },
    ],
    data: [xs, ...dds],
  });

  const mx = g.log.map((t) => t.turn + 1);
  const netOf = (t) => (Number.isFinite(t.netExposure) ? t.netExposure : t.exposure);
  const longs = g.log.map((t) => (netOf(t) > 1e-6 ? netOf(t) : null));
  const shorts = g.log.map((t) => (netOf(t) < -1e-6 ? netOf(t) : null));
  S.charts.resExp = makeChart({
    el: $("resExpChart"), height: 220, yFmt: (v) => pct(v, 0), xFmt: (v) => `${v}`, zeroLine: true, xIncrs: [1, 2, 3, 6, 12],
    xRange: () => [0.5, g.log.length + 0.5],
    xLabel: "Month", xLabelFmt: (v) => `Month ${v}`,
    yRange: (u, min, max) => [Math.min(-0.25, (min ?? 0) * 1.1), Math.max(0.25, (max ?? 0) * 1.1)],
    series: [
      { label: "Long", colorVar: "--pos", bars: true, fmt: (v) => pct(v, 0) },
      { label: "Short", colorVar: "--neg", bars: true, fmt: (v) => pct(v, 0) },
    ],
    data: [mx, longs, shorts],
  });

  // Coach
  const notes = debrief(g, benches);
  $("coachNotes").innerHTML = notes.map((n) => `<div class="note"><h3><span class="badge ${n.tone}">${n.tone === "good" ? "✓ good" : n.tone === "bad" ? "! watch" : "• note"}</span>${n.title}</h3><p>${n.text}</p>${n.detail ? `<p class="detail">${n.detail}</p>` : ""}</div>`).join("");

  // Log
  $("logTable").querySelector("tbody").innerHTML = g.log.map((t) => {
    const legs = t.action.legs.map((l) => `${l.side === "B" ? "Buy" : "Write"} ${l.strike}${l.type} ×${pct(l.notional, 0)}`).join(", ") || "–";
    const yr = t.equityEnd / t.equityStart - 1;
    return `<tr><td>${t.turn + 1}${cfg.blind ? "" : ` · from ${fmtDate(S.market.dates[t.startIdx])}`}</td><td class="num ${signClass(t.stockReturn)}">${pct(t.stockReturn, 1, true)}</td>
      <td class="num">${pct(netOf(t), 0)}</td><td>${legs}</td><td class="num">${t.action.legs.length ? money(t.optionPnl) : "–"}</td>
      <td class="num ${signClass(yr)}">${pct(yr, 1, true)}</td><td class="num">${money(t.equityEnd)}</td></tr>`;
  }).join("");
  $("copyMsg").textContent = "";
}

function replayUrl() {
  const code = encodeReplay(S.cfg, S.actions);
  return `${location.origin}${location.pathname}#/replay/${code}`;
}

async function copyReplay() {
  const url = replayUrl();
  try {
    await navigator.clipboard.writeText(url);
    $("copyMsg").textContent = "Replay link copied.";
  } catch {
    $("copyMsg").innerHTML = `Copy this link: <a href="${url}">${url.slice(0, 60)}…</a>`;
  }
}

async function openReplay(code) {
  try {
    const { cfg, actions } = decodeReplay(code);
    validateReplayCfg(cfg, actions);
    await setupGame(cfg);
    for (const a of actions) {
      if (S.game.over) break;
      if (!S.game.check(a).ok) throw new Error("This replay doesn't match the data (it may be from an older version).");
      S.game.play(a);
      S.actions.push(normalizeAction(a));
    }
    if (!S.game.over) throw new Error("This replay link is incomplete.");
    S.replay = true;
    S.benchmarks = runBenchmarks(S.market, { startIdx: S.game.startIdx, turns: S.game.turns }, S.spyMarket);
    show("results");
    renderResults();
  } catch (e) {
    fatal(e, { quiet: true });
    show("home");
    renderResume();
  }
}

function validateReplayCfg(cfg, actions) {
  const fullTurns = (S.meta.game_years || 5) * 12;
  const bad = (m) => { throw new Error(`This replay link isn't valid (${m}).`); };
  if (!cfg || typeof cfg !== "object") bad("no game settings");
  if (!poolInfo().some((p) => p.symbol === cfg.sym)) bad("unknown stock");
  if (cfg.fullTurns !== fullTurns) bad("different game length");
  if (![12, fullTurns].includes(cfg.turns)) bad("unsupported number of months");
  if (!Number.isInteger(cfg.startTurn) || cfg.startTurn < 0 || cfg.startTurn > fullTurns - cfg.turns) bad("bad start month");
  if (typeof cfg.end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.end) || cfg.end > S.meta.as_of) bad("bad end date");
  if (!Array.isArray(actions) || actions.length > cfg.turns) bad("bad action list");
  cfg.blind = !!cfg.blind;
}

// ------------------------------------------------------------------ data page

function renderDataPage() {
  const m = S.meta;
  const stale = isStale(m);
  $("dataLede").innerHTML = `Daily closes through <strong>${fmtDate(m.as_of)}</strong>. Last data change committed ${m.updated_at ? m.updated_at.replace("T", " ").replace("Z", " UTC") : "–"}. Status: ${stale ? '<span class="status-stale">stale: the last refresh had problems</span>' : '<span class="status-ok">up to date</span>'}.`;
  const rows = Object.entries(m.series).map(([file, s]) => {
    const bad = s.stale || (m.failures && m.failures[s.symbol]);
    return `<tr><td>${s.symbol}</td><td>${s.source}</td><td class="num">${s.rows.toLocaleString("en-US")}</td><td>${s.first}</td><td>${s.last}</td><td>${bad ? '<span class="status-stale">stale</span>' : '<span class="status-ok">ok</span>'}</td></tr>`;
  });
  $("dataTable").querySelector("tbody").innerHTML = rows.join("");
  const repo = m.repo || "cartermburke/FMKT256-AI-Proj";
  $("dataLinks").innerHTML = `<a href="https://github.com/${repo}/actions/workflows/update-data.yml">Update job run history</a> · <a href="https://github.com/${repo}/commits/">Commit history (data refreshes are "data: refresh prices…")</a> · <a href="https://github.com/${repo}/blob/HEAD/config/tickers.json">Ticker config</a>${m.run_url ? ` · <a href="${m.run_url}">Latest data run</a>` : ""}`;
}
