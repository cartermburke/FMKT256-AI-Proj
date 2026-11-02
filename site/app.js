// Blind Tape: UI controller. All market logic lives in engine/ (pure, unit-tested); this file
// only renders it. Engine copy (coach notes, order errors, strategy names) is shown verbatim.
import { buildMarket, firstUsableIndex } from "./engine/market.js";
import { Game, RULES, normalizeAction, legalize } from "./engine/game.js";
import { rankStrategies, RANK_METRICS } from "./engine/scoring.js";
import { SPREAD } from "./engine/options.js";
import { STRATEGIES, runBenchmarks } from "./engine/strategies.js";
import { debrief } from "./engine/coach.js";
import { encodeReplay, decodeReplay } from "./engine/replay.js";
import { mulberry32, pick, randInt, newSeed } from "./engine/rng.js";
import { drawdownSeries } from "./engine/metrics.js";
import { loadMeta, loadBundle, loadSeries } from "./ui/data.js";
import { makeChart, rebuildAll, lineKey } from "./ui/charts.js";
import { monthTicks } from "./ui/ticks.js";
import { money, pct, num, signClass, fmtDate, fmtMonthYear, isoToSec, change, ordinal } from "./ui/format.js";

const $ = (id) => document.getElementById(id);
const TD = RULES.turnDays;
const HISTORY_DAYS = 252; // a game's price chart starts a year before the game
const HERO_MARGIN = 63; // the home sample ends this far before any game chart: links up to 3 months old
const STRAT_COLORS = { you: "--s1", buyHold: "--s2", spy: "--s3", coveredCall: "--s4", protectivePut: "--s5", trend200: "--s6", challenger: "--s7" };
// Benchmarks are muted and told apart by line pattern as well as color.
const STRAT_DASH = { spy: [7, 4], coveredCall: [2, 3], protectivePut: [9, 3, 2, 3], trend200: [1, 4] };
const SAVE_KEY = "bt-save-v1";
const TIP_KEY = "bt-tip-seen";
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  challenger: null, // { name, results, game } when playing a head-to-head challenge
  challengeCode: null,
  lastToast: "",
  ceremony: false,
  revealDates: true,
};

// ------------------------------------------------------------------ boot

init().catch((e) => fatal(e));

async function init() {
  initTheme();
  wireStatic();
  // Routing starts at once: How it works needs no data, so it opens while the data loads (or
  // after it fails). Every other screen waits for the data index; route() reads the hash when
  // it runs, so a link clicked while loading is still honored.
  window.addEventListener("hashchange", route);
  window.addEventListener("storage", onStorage);
  // The footer keeps clear of the fixed action bar at whatever height the bar has.
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--ab-h", `${Math.ceil($("actionBar").getBoundingClientRect().height)}px`);
  }).observe($("actionBar"));
  await null; // the routing state below this function in the module is set up first
  initHow(); // the reader's view of How it works, set before any route can show it
  // Mark the entry this page loaded on: what is behind it isn't this page's, so a No to a
  // challenge there goes home instead of stepping back.
  history.replaceState({ ...history.state, landing: true }, "");
  route();
  try {
    S.meta = await loadMeta();
  } catch (e) {
    console.error(e);
    $("bootMsg").textContent = "Couldn't load the market data. Check your connection and try again.";
    $("bootRetry").hidden = false;
    renderHowNumbers(true);
    return;
  }
  renderHomeMeta();
  renderDataPage();
  renderHowNumbers();
  route();
}

function fatal(e, { quiet = false } = {}) {
  if (!quiet) console.error(e);
  const b = $("staleBanner");
  b.dataset.err = "1";
  b.textContent = `Something went wrong: ${e.message}`;
}

/** Take an error message down once the player has moved on; a stale-data notice stays. */
function clearError() {
  const b = $("staleBanner");
  if (!b.dataset.err) return;
  delete b.dataset.err;
  b.textContent = b.dataset.stale || "";
}

/** Decode a shared link, with one plain message for any link that was cut short or changed. */
function decodeLink(code, kind) {
  try {
    const r = decodeReplay(code);
    if (!r || !r.cfg || typeof r.cfg !== "object" || !Array.isArray(r.actions)) throw new Error("no settings");
    return r;
  } catch {
    throw new Error(`This ${kind} link is incomplete or was changed. Copy the whole link and try again.`);
  }
}

// ------------------------------------------------------------------ storage

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked: the game still works in memory */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Each tab tags what it saves, so a tab can tell when another one has replaced the game.
const TAB = Math.random().toString(36).slice(2, 10);

/** Keep the current game in this browser so a reload picks it back up. */
function saveGame() {
  if (!S.game || S.replay || !S.cfg || S.saveStale) return;
  store(SAVE_KEY, JSON.stringify({ code: encodeReplay(S.cfg, S.actions), challenge: S.challengeCode || null, tab: TAB }));
}

/**
 * Load the saved game. keep: the save came from another tab, so if this tab can't load it,
 * it leaves the save alone for that tab instead of dropping it.
 */
async function restoreSave({ keep = false } = {}) {
  const raw = load(SAVE_KEY);
  if (!raw) return false;
  const drop = () => { if (!keep) store(SAVE_KEY, null); S.game = null; return false; };
  let code, challenge, cfg, actions;
  try {
    ({ code, challenge } = JSON.parse(raw));
    ({ cfg, actions } = decodeReplay(code));
  } catch {
    return drop(); // the saved game itself is unreadable: drop it quietly and start fresh
  }
  // Saved with newer market data than this tab loaded (the tab was opened before the daily
  // refresh, or the site was mid-update): the save is fine, this tab is out of date. Keep it
  // and ask for a reload.
  if (typeof cfg?.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cfg.end) && cfg.end > S.meta.as_of) {
    S.game = null;
    tabNote("The saved game uses newer market data than this tab has. Reload the page to pick it up.");
    return false;
  }
  try {
    validateReplayCfg(cfg, actions);
  } catch {
    return drop();
  }
  try {
    await setupGame(cfg);
  } catch {
    // The price data didn't load: keep the save for the next visit, and say so, so the home
    // screen doesn't look as if the game never existed.
    S.game = null;
    tabNote("Couldn't load the prices for your saved game. Check your connection and reload the page to resume it.");
    return false;
  }
  try {
    if (challenge) await attachChallenger(challenge);
    for (const a of actions) {
      if (S.game.over) break;
      if (!S.game.check(a).ok) throw new Error("saved game no longer matches the data");
      S.game.play(a);
      S.actions.push(normalizeAction(a));
    }
  } catch {
    return drop();
  }
  // Bring back the last month's summary, as it was before the reload.
  const lastTurn = S.game.log[S.game.log.length - 1];
  if (lastTurn && !S.game.over) S.lastToast = beatFor(lastTurn, lastTurn.equityStart, lastTurn.equityEnd);
  if (S.game.over) S.benchmarks = runBenchmarks(S.market, { startIdx: S.game.startIdx, turns: S.game.turns }, S.spyMarket);
  ownSave();
  return true;
}

/** This tab now holds the game in storage (it started or reloaded it): saving resumes. */
function ownSave() {
  S.saveStale = false;
  $("tabNote").hidden = true;
}

function tabNote(text) {
  const n = $("tabNote");
  if (!n.hidden && n.textContent === text) return; // already showing: don't announce it again
  n.hidden = false;
  n.textContent = text;
}

/**
 * Another tab saved a game. If this tab isn't showing a game of its own, pick it up; if it
 * is (playing or on its results), say so and stop saving here.
 */
function onStorage(e) {
  if (e.key !== SAVE_KEY || !e.newValue || !S.meta) return; // before the data is in, the first route reads the save anyway
  let from = null;
  try { from = JSON.parse(e.newValue).tab; } catch { /* unreadable: treat as another tab */ }
  if (from === TAB) return;
  // Queued behind any route in progress, so the two never load a game at the same time.
  routeChain = routeChain.then(() => otherTabSaved()).catch((err) => fatal(err));
}

async function otherTabSaved() {
  if (S.replay) return;
  // The event waited behind a game this tab started or opened since: storage now holds this
  // tab's own save, so the event is out of date and this tab is the one that saves.
  try { if (JSON.parse(load(SAVE_KEY))?.tab === TAB) return; } catch { /* unreadable: carry on */ }
  if (!S.game || (S.screen !== "game" && S.screen !== "results")) {
    S.game = null;
    await restoreSave({ keep: true });
    renderResume();
    return;
  }
  S.saveStale = true;
  tabNote("This game was changed in another tab, so this tab has stopped saving it. Reload to pick up the latest game.");
}

// ------------------------------------------------------------------ theme

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function syncThemeButton() {
  const dark = currentTheme() === "dark";
  const b = $("themeToggle");
  b.setAttribute("aria-pressed", String(dark));
  b.setAttribute("aria-label", "Dark theme");
  b.title = dark ? "Dark theme is on" : "Dark theme is off";
}

function initTheme() {
  const saved = load("bt-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  syncThemeButton();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { syncThemeButton(); rebuildAll(); });
  $("themeToggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store("bt-theme", next);
    syncThemeButton();
    rebuildAll();
  });
}

// ------------------------------------------------------------------ routing

function show(screen) {
  const prev = S.screen;
  S.screen = screen;
  $("boot").hidden = true;
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== `screen-${screen}`;
  markNav(screen);
  window.scrollTo(0, 0);
  // On a change of screen (not the first load, so Tab still starts at the skip link), move
  // focus to the new screen: its heading, or the page itself on the game screen, where
  // Enter then plays the month.
  if (prev && prev !== screen) {
    const t = screen === "game" ? $("app") : document.querySelector(`#screen-${screen} h1`);
    if (t) {
      if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
      t.focus({ preventScroll: true });
    }
  }
}

/** Mark the nav link for a screen as the current page. */
function markNav(screen) {
  for (const a of document.querySelectorAll(".nav a")) {
    const n = a.dataset.nav;
    const on = n === screen || (n === "home" && ["game", "results"].includes(screen));
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

// Routes run one at a time: a hashchange that arrives while a game is loading waits for it,
// so a saved game is never restored twice.
let routeSeq = 0;
let routeChain = Promise.resolve();
function route(e) {
  const seq = ++routeSeq;
  // The hash this navigation left (a hashchange says): a challenge link opened from the game
  // steps back only onto that game's own #/play.
  const from = e && e.oldURL ? new URL(e.oldURL).hash : null;
  routeChain = routeChain.then(() => routeNow(seq, from)).catch((err) => fatal(err));
  return routeChain;
}

async function routeNow(seq, from = null) {
  const h = location.hash || "#/";
  if (!S.meta) {
    // Still loading the data index, or it failed: How it works opens anyway; anything else
    // shows the loading (or failure) message instead of an empty page.
    if (h === "#/how") { if (S.screen !== "how") show("how"); return; }
    S.screen = null;
    for (const el of document.querySelectorAll(".screen")) el.hidden = true;
    $("boot").hidden = false;
    markNav(h === "#/data" ? "data" : "home");
    return;
  }
  clearError();
  if (h.startsWith("#/replay/")) {
    await openReplay(h.slice("#/replay/".length), seq);
    return;
  }
  if (h.startsWith("#/challenge/")) {
    await openChallenge(h.slice("#/challenge/".length), seq, from);
    return;
  }
  await loadHomeGame(!["#/play", "#/results", "#/how", "#/data"].includes(h));
  if (seq !== routeSeq) return; // a newer route is queued; it picks the screen
  if (h === "#/play" && S.game && !S.game.over) { show("game"); renderGame(true); return; }
  if ((h === "#/play" || h === "#/results") && S.game && S.game.over) {
    // Replace rather than push, so Back from the results leaves them.
    if (h !== "#/results") history.replaceState(null, "", "#/results");
    show("results");
    renderResults();
    return;
  }
  if (h === "#/how") { if (S.screen !== "how") show("how"); return; } // keeps the reader's place
  if (h === "#/data") { show("data"); return; }
  show("home");
  renderResume();
}

/**
 * Pick the game the screens outside a replay show. Leaving a replay drops it, so the game in
 * progress (kept in storage) comes back. home: a tab whose save was replaced elsewhere shows
 * the saved game on the home screen, as a tab already there does.
 */
async function loadHomeGame(home) {
  if (S.replay) { S.game = null; S.replay = false; }
  if (S.saveStale && home) {
    // The old game stays in memory (unsaved: saveStale blocks saveGame) until the saved one is
    // in, so the game screen still showing while it loads never meets an empty game. The save
    // is another tab's, so a failed load leaves it alone.
    if (!(await restoreSave({ keep: true }))) S.game = null;
  } else if (!S.game) await restoreSave();
}

function renderResume() {
  const card = $("resumeCard");
  const active = S.game && !S.game.over;
  card.hidden = !active;
  if (active) $("resumeText").textContent = `Month ${S.game.turn + 1} of ${S.game.turns} · equity ${money(S.game.equity)}`;
}

// ------------------------------------------------------------------ wiring

function wireStatic() {
  $("bootRetry").addEventListener("click", () => location.reload());
  $("startFull").addEventListener("click", () => newGame("full"));
  $("resumeBtn").addEventListener("click", () => { location.hash = "#/play"; });
  $("startQuick").addEventListener("click", () => newGame("quick"));
  $("optTicker").addEventListener("change", (e) => {
    if (e.target.value) $("optBlind").checked = false;
  });
  $("playAgain").addEventListener("click", playAgain);
  $("copyReplay").addEventListener("click", copyReplay);
  $("challengeBtn").addEventListener("click", copyChallenge);

  $("stockSlider").addEventListener("input", (e) => {
    S.stockTarget = Number(e.target.value) / 100;
    updateTicket();
  });
  for (const b of document.querySelectorAll(".quick-btns button[data-x]")) {
    b.addEventListener("click", () => {
      S.stockTarget = Number(b.dataset.x) / 100;
      $("stockSlider").value = b.dataset.x;
      updateTicket();
    });
  }
  $("keepBtn").addEventListener("click", () => {
    S.stockTarget = null;
    syncSlider();
    updateTicket();
  });
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

  // Enter advances the month, but only when nothing else has focus.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ($("screen-game").hidden) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== $("app")) return;
    if (!$("nextTurn").disabled) { e.preventDefault(); nextTurn(); }
  });
  // Reveal: any click or key during the ceremony skips to the end.
  const skipReveal = () => {
    const viaSkip = document.activeElement === $("revealSkip");
    endCeremony();
    // The Skip button hides itself, so keep keyboard focus on the results.
    if (viaSkip) $("revealTitle").focus({ preventScroll: true });
  };
  $("revealSkip").addEventListener("click", skipReveal);
  $("revealBlock").addEventListener("click", (e) => { if (S.ceremonyOn && e.target !== $("revealSkip")) endCeremony(); });
  document.addEventListener("keydown", (e) => {
    if (!S.ceremonyOn || $("screen-results").hidden || (e.key !== "Escape" && e.key !== " ")) return;
    if (e.key === " " && e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === " ") e.preventDefault(); // Space skips; it shouldn't also page down
    skipReveal();
  });
  // The skip link moves focus to the content without changing the route.
  document.querySelector(".skip-link").addEventListener("click", (e) => {
    e.preventDefault();
    $("app").focus();
  });
  // How it works: contents links scroll within the page (the hash is used for routing) and
  // take focus with them, so reading and Tab continue from the section.
  for (const a of document.querySelectorAll("[data-jump]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = $(a.dataset.jump);
      if (!t) return;
      if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
      t.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      t.focus({ preventScroll: true });
    });
  }
}

function renderHomeMeta() {
  const m = S.meta;
  const sel = $("optTicker");
  for (const p of poolInfo()) sel.add(new Option(`${p.symbol} (${p.name})`, p.symbol));
  const stale = isStale(m);
  // The S&P 500 is in the pool as its ETF: count it apart from the stocks.
  const n = poolInfo().length;
  const withIndex = poolInfo().some((p) => p.symbol === (m.benchmark || "SPY"));
  const what = withIndex ? `${n - 1} stocks and the S&amp;P 500` : `${n} stocks`;
  $("homeData").innerHTML = `${what} · real daily closes through <strong>${fmtDate(m.as_of)}</strong> · updated every weekday · <a href="#/data">data status</a>`;
  if (stale) {
    const b = $("staleBanner");
    b.dataset.stale = `Heads up: the latest market data is from ${fmtDate(m.as_of)}. The daily refresh may have failed; the game still works on the last good data.`;
    if (!b.dataset.err) b.textContent = b.dataset.stale;
  }
  drawHeroTape();
}

/**
 * The home page's sample tape is real: the S&P 500 ETF rebased to 100 like a blind game, over
 * months that end three months before the earliest day any game's chart shows (a year before
 * the game window), so games from links up to three months old don't overlap it either. The
 * S&P 500 is in the blind pool, so the sample can't give away a game's future or let a blind
 * game be recognized. It stays an empty frame if the prices can't be loaded.
 */
async function drawHeroTape() {
  let spy;
  try { spy = await loadSeries("SPY"); } catch { return; }
  const m = S.meta;
  const dates = spy.dates || [];
  const closes = spy.close || [];
  let last = dates.length - 1;
  while (last > 0 && dates[last] > m.as_of) last--;
  const end = last - (m.game_years || 5) * 12 * TD - HISTORY_DAYS - HERO_MARGIN; // well before the earliest game chart
  const months = Math.min(24, Math.floor(end / TD));
  const start = end - months * TD;
  if (months < 6 || !(closes[start] > 0)) return;
  const pts = [];
  for (let d = start; d <= end; d += TD) pts.push((100 * closes[d]) / closes[start]);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const y = (v) => (84 - (78 * (v - lo)) / Math.max(1e-9, hi - lo)).toFixed(1);
  const path = pts.map((v, i) => `${i ? "L" : "M"}${((320 * i) / (pts.length - 1)).toFixed(1)} ${y(v)}`).join(" ");
  const month = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const fig = $("tapeDemo");
  fig.querySelector("path").setAttribute("d", path);
  $("tapeMeta").textContent = `${month(dates[start])} to ${month(dates[end])}`;
  $("tapeEnd").textContent = `ends at ${pts[pts.length - 1].toFixed(0)}`;
  $("tapeName").textContent = "S&P 500 ETF (SPY)";
  fig.classList.add("ready");
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

// Queued like a route, so a game another tab saved that is still loading here can't replace
// the one the player just asked for.
function newGame(mode, opts = {}) {
  if (S.starting) return routeChain; // a second press while the first game's prices load
  if (!okToReplace("Start a new game?")) return routeChain;
  // The pressed card shows it's working until the game opens (or fails).
  S.starting = true;
  const card = mode === "full" ? $("startFull") : $("startQuick");
  card.setAttribute("aria-busy", "true");
  card.classList.add("is-loading");
  routeChain = routeChain.then(() => startNewGame(mode, opts)).catch((e) => fatal(e)).finally(() => {
    S.starting = false;
    card.removeAttribute("aria-busy");
    card.classList.remove("is-loading");
  });
  return routeChain;
}

/**
 * The unfinished game that starting another would replace (only one game is kept), once at
 * least a month of it has been played: { turn, turns }, or null.
 */
function gameAtRisk() {
  if (S.game && !S.replay && !S.saveStale) return !S.game.over && S.actions.length ? { turn: S.game.turn, turns: S.game.turns } : null;
  // No game in this tab (or a replay is showing, or another tab has saved over this one's): the
  // one at stake is the saved game.
  try {
    const { cfg, actions } = decodeReplay(JSON.parse(load(SAVE_KEY)).code);
    if (Array.isArray(actions) && actions.length > 0 && actions.length < cfg.turns) return { turn: actions.length, turns: cfg.turns };
  } catch { /* nothing saved, or unreadable */ }
  return null;
}

/** Ask before a game in progress is replaced; true when there is none, or the player agrees. */
function okToReplace(question) {
  const g = gameAtRisk();
  return !g || confirm(`${question} Your game in progress (month ${g.turn + 1} of ${g.turns}) will be replaced.`);
}

async function startNewGame(mode, opts) {
  const seed = newSeed();
  const rng = mulberry32(seed);
  const pool = poolInfo().map((p) => p.symbol);
  const chosen = opts.sym !== undefined ? opts.sym : $("optTicker").value;
  const sym = chosen || pick(rng, pool);
  const fullTurns = (S.meta.game_years || 5) * 12;
  const turns = mode === "quick" ? 12 : fullTurns;
  const startTurn = mode === "quick" ? randInt(rng, 0, fullTurns - turns + 1) : 0;
  const blind = opts.blind !== undefined ? opts.blind : chosen ? false : $("optBlind").checked;
  const cfg = { v: 1, sym, end: S.meta.as_of, fullTurns, startTurn, turns, blind, seed, mode };
  try {
    await setupGame(cfg);
  } catch (e) {
    fatal(e);
    return;
  }
  clearError();
  S.replay = false;
  ownSave();
  saveGame();
  // From the results, replace that entry rather than push: those results are gone, so Back
  // from the new game (or its results) leaves in one press.
  if (location.hash === "#/results") history.replaceState(null, "", "#/play");
  if (location.hash === "#/play") { show("game"); renderGame(true); }
  else location.hash = "#/play";
}

function playAgain() {
  const c = S.cfg;
  if (!c) { location.hash = "#/"; return; }
  // Same mode and blind setting; an open game keeps its stock, a blind one draws a new one.
  newGame(c.mode === "quick" || c.turns === 12 ? "quick" : "full", { blind: c.blind, sym: c.blind ? "" : c.sym });
}

async function setupGame(cfg) {
  let bundle;
  try {
    bundle = await loadBundle(cfg.sym);
  } catch (e) {
    // The error names the price file; a blind game's must not name its stock.
    if (cfg.blind) throw new Error("Couldn't load the prices for this game. Check your connection and try again.");
    throw e;
  }
  const market = buildMarket(bundle, { endDate: cfg.end });
  const spyMarket = buildMarket({ stock: bundle.spy, spy: bundle.spy, vix: bundle.vix, irx: bundle.irx }, { endDate: cfg.end });
  const fullStart = market.last - cfg.fullTurns * TD;
  const startIdx = fullStart + cfg.startTurn * TD;
  if (fullStart < firstUsableIndex(market)) throw new Error(`Not enough history for ${cfg.blind ? "this stock" : cfg.sym}.`);
  S.cfg = cfg;
  S.market = market;
  S.spyMarket = spyMarket;
  S.game = new Game(market, { startIdx, turns: cfg.turns });
  S.actions = [];
  S.legs = [];
  S.legNote = "";
  S.stockTarget = null;
  S.benchmarks = null;
  S.challenger = null;
  S.challengeCode = null;
  S.lastToast = "";
  S.ceremony = false;
  for (const k of Object.keys(S.charts)) { S.charts[k].destroy(); delete S.charts[k]; }
  document.querySelector(".autopilot").open = false;
  $("errors").dataset.last = "";
  $("errors").dataset.text = "";
  $("errors").innerHTML = "";
  clearTimeout(S.alertTimer);
  cancelAnimationFrame(S.alertFrame);
  $("errorAlert").textContent = "";
  $("turnToast").dataset.last = "";
  $("turnToast").innerHTML = "";
  cancelAnimationFrame(S.announceFrame);
  $("orderStatus").textContent = "";
  resetCeremony();
}

// ------------------------------------------------------------------ game screen

const realPx = (x) => (S.cfg.blind ? x : x / S.game.base);
const priceFmt = (v) => (S.cfg.blind ? v.toFixed(1) : `$${v.toFixed(2)}`);
const isPhone = () => window.innerWidth < 700;

function monthLabelFor(x) {
  const g = S.game;
  const idx = Math.round(g.startIdx + x * TD);
  if (!S.cfg.blind && S.market.dates[idx]) return fmtDate(S.market.dates[idx]);
  return monthsWords(x);
}

/** Month-start ticks for this game's charts (see ui/ticks.js). */
const monthTicksFor = (startIdx, min, max, incr) => monthTicks(S.market.dates, startIdx, min, max, incr, TD);

/** Blind-mode time in words: "Start", "2.5 months in", "3.0 months before the start". */
function monthsWords(x) {
  const m = Math.round(x * 10) / 10;
  if (Math.abs(m) < 0.05) return "Start";
  return m < 0 ? `${(-m).toFixed(1)} months before the start` : `${m.toFixed(1)} months in`;
}

function setChange(el, x, fmt) {
  const c = change(x, fmt);
  el.textContent = c.text;
  el.className = `${el.className.replace(/\b(gain|loss|flat)\b/g, "").trim()} ${c.cls}`.trim();
}

function renderGame(fresh = false) {
  const g = S.game;
  const ctx = g.context();
  const totalRet = g.equity / RULES.stake - 1;
  const month = Math.min(ctx.turn + 1, g.turns);
  $("sTurn").textContent = `${month} of ${g.turns}`;
  $("sRail").style.width = `${(100 * ctx.turn) / g.turns}%`;
  $("sEquity").textContent = money(g.equity);
  setChange($("sReturn"), totalRet);
  $("sReturn").setAttribute("aria-label", `Return since the start: ${pct(totalRet, 1, true)}`);
  $("sExposure").textContent = pct(ctx.exposure, 0);
  $("sCash").textContent = money(ctx.cash);
  $("abMonth").textContent = `Month ${month} of ${g.turns}`;
  $("abEquity").textContent = money(g.equity);
  $("screen-game").classList.toggle("is-blind", !!S.cfg.blind);

  const h2h = $("h2hBanner");
  h2h.hidden = !S.challenger;
  if (S.challenger) {
    h2h.textContent = `Head-to-head: ${S.challenger.name} played this exact tape. Their score stays hidden until you finish, then you're ranked side by side.`;
  }
  // The month summary is written once per month, so coming back to the screen doesn't repeat it.
  // The region is never hidden, only empty (it collapses), so the first summary is announced too.
  const toast = $("turnToast");
  if (toast.dataset.last !== S.lastToast) {
    toast.dataset.last = S.lastToast;
    toast.innerHTML = S.lastToast;
  }

  if (S.cfg.blind) {
    $("priceTitle").textContent = "Mystery stock";
    $("priceSub").textContent = "Price starts at 100 · gray line: 200-day average · axis: months from the start";
  } else {
    const p = poolInfo().find((q) => q.symbol === S.cfg.sym);
    $("priceTitle").textContent = `${p ? p.name : S.cfg.sym} (${S.cfg.sym})`;
    $("priceSub").textContent = `Adjusted price in dollars · ${fmtDate(S.market.dates[g.idx])} · gray line: 200-day average`;
  }
  $("accountSub").textContent = `Daily value of your account next to simply holding the stock${S.cfg.blind ? " · axis: months from the start" : ""}`;

  // Price history: up to one year before the start, through today, with the player's trades marked.
  const from = Math.max(0, g.startIdx - HISTORY_DAYS);
  const xs = [];
  const px = [];
  const ma = [];
  for (let d = from; d <= g.idx; d++) {
    xs.push((d - g.startIdx) / TD);
    px.push(realPx(g.S[d]));
    const sm = S.market.sma200[d] * g.base;
    ma.push(Number.isFinite(sm) ? realPx(sm) : null);
  }
  const marks = [];
  let prevNet = 0;
  for (const t of g.log) {
    const net = Number.isFinite(t.netExposure) ? t.netExposure : t.exposure;
    if (Math.abs(net - prevNet) > 0.01) marks.push({ x: (t.startIdx - g.startIdx) / TD, y: realPx(g.S[t.startIdx]), up: net > prevNet });
    prevNet = net;
  }
  const xFmt = (v) => (S.cfg.blind ? `${v > 0 ? "+" : ""}${v}` : (() => {
    const d = S.market.dates[Math.round(g.startIdx + v * TD)];
    return d ? fmtMonthYear(d) : "";
  })());
  const extra = { marks, vlines: [{ x: 0, label: "Start" }] };
  // Open games label real months; blind ones count months from the start.
  const xSplits = S.cfg.blind ? null : (min, max, incr) => monthTicksFor(S.game.startIdx, min, max, incr);
  if (!S.charts.price) {
    S.charts.price = makeChart({
      el: $("priceChart"), height: () => (isPhone() ? 190 : 260), xFmt, xSplits, xSpace: S.cfg.blind ? 40 : 76, rightPad: S.cfg.blind ? 22 : 32, yFmt: priceFmt, xLabel: "When", xLabelFmt: monthLabelFor, xIncrs: [1, 2, 3, 6, 12, 24],
      series: [
        { label: "Price", colorVar: "--ink", width: 1.75, fmt: priceFmt },
        { label: "200-day average", colorVar: "--ref", width: 1.25, fmt: priceFmt },
      ],
      data: [xs, px, ma],
      ...extra,
    });
  } else {
    S.charts.price.update([xs, px, ma], extra);
  }

  // Your account vs holding the stock: a sentence until there's a line to draw.
  const hasLine = g.curve.idx.length > 1;
  $("equityEmpty").hidden = hasLine;
  $("equityChart").hidden = !hasLine;
  if (hasLine) {
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
        el: $("equityChart"), height: () => (isPhone() ? 170 : 200), xSpace: S.cfg.blind ? 40 : 76, rightPad: S.cfg.blind ? 22 : 32, xFmt, xSplits, yFmt: mFmt, xLabel: "When", xLabelFmt: monthLabelFor, xIncrs: [1, 2, 3, 6, 12, 24],
        xRange: () => [0, Math.max(1, S.game.turn)],
        series: [
          { label: "You", colorVar: "--you", width: 2.25, fmt: (v) => money(v) },
          { label: "Holding the stock", colorVar: "--s2", width: 1.5, dash: [5, 4], fmt: (v) => money(v) },
        ],
        data: [ex, eq, hold],
      });
    } else {
      S.charts.equity.update([ex, eq, hold]);
    }
  }

  syncSlider();
  renderQuotes();
  updateTicket();
  if (fresh) teachOnce();
}

/** Put the slider on the pending target, or on the current position when there is none. */
function syncSlider() {
  const x = S.stockTarget ?? S.game.exposure();
  const cur = Math.max(-100, Math.min(150, Math.round((x * 100) / 5) * 5));
  $("stockSlider").value = String(cur);
  paintSlider();
}

/** Fill the slider track from the zero mark to the thumb: long on the right, short on the left. */
function paintSlider() {
  const el = $("stockSlider");
  const min = Number(el.min);
  const span = Number(el.max) - min;
  const z = (0 - min) / span;
  const t = (Number(el.value) - min) / span;
  const at = (f) => `calc(11px + (100% - 22px) * ${f.toFixed(4)})`;
  el.style.setProperty("--lo", at(Math.min(z, t)));
  el.style.setProperty("--hi", at(Math.max(z, t)));
  el.style.setProperty("--fill", t >= z ? "var(--long)" : "var(--short)");
}

/** First game only: point at the at-the-money call's ask, once. */
function teachOnce() {
  if (load(TIP_KEY)) return;
  store(TIP_KEY, "1");
  const btn = document.querySelector('#quotesTable tr.atm button.px[data-side="B"][data-type="C"]');
  if (btn) {
    btn.classList.add("pulse");
    setTimeout(() => btn.classList.remove("pulse"), 2600);
  }
  $("quotePeek").textContent = "Tap a price to trade.";
}

function renderQuotes() {
  const g = S.game;
  const q = g.quotes();
  const tb = $("quotesTable").querySelector("tbody");
  tb.innerHTML = "";
  const f = (v) => realPx(v).toFixed(2);
  const peek = $("quotePeek");
  const restPeek = () => { peek.textContent = S.cfg.blind ? "Tap a price to trade (start-at-100 scale)." : "Tap a price to trade (dollars per share)."; };
  restPeek();
  for (const row of q.rows) {
    const tr = document.createElement("tr");
    if (row.strike === 100) tr.className = "atm";
    const kLabel = S.cfg.blind ? `${row.strike}%` : `${row.strike}% <span class="muted">$${realPx(row.K).toFixed(2)}</span>`;
    tr.innerHTML = `<td class="k">${kLabel}${row.strike === 100 ? '<span class="atm-tag">at the money</span>' : ""}</td><td class="ivc">${pct(row.iv, 0)}</td>`;
    for (const type of ["C", "P"]) {
      const itm = type === "C" ? row.strike < 100 : row.strike > 100;
      for (const side of ["W", "B"]) {
        const td = document.createElement("td");
        if (itm) td.className = "itm";
        const b = document.createElement("button");
        b.type = "button";
        b.className = `px ${side === "B" ? "buy" : "sell"}`;
        b.dataset.side = side;
        b.dataset.type = type;
        b.textContent = f(side === "W" ? row[type].bid : row[type].ask);
        b.title = `${side === "B" ? "Buy" : "Write (sell)"} the ${row.strike}% ${type === "C" ? "call" : "put"} at ${b.textContent}${itm ? ", in the money" : ""}`;
        b.setAttribute("aria-label", b.title);
        const say = `${side === "B" ? "Buy" : "Sell"} ${row.strike} ${type === "C" ? "call" : "put"} · ${S.cfg.blind ? "" : "$"}${b.textContent}${itm ? " · in the money" : ""}`;
        b.addEventListener("mouseenter", () => { peek.textContent = say; });
        b.addEventListener("focus", () => { peek.textContent = say; });
        b.addEventListener("mouseleave", restPeek);
        b.addEventListener("blur", restPeek);
        b.addEventListener("click", () => addLeg(side, type, row.strike, Number($("legSize").value)));
        td.appendChild(b);
        tr.appendChild(td);
      }
    }
    tb.appendChild(tr);
  }
  $("optMeta").textContent = `At-the-money vol ${pct(q.iv, 1)} · T-bill ${pct(q.r, 2)}`;
}

function addLeg(side, type, strike, notional) {
  if (S.legs.length >= RULES.maxLegs) {
    S.legNote = `You can trade at most ${RULES.maxLegs} option legs a month. Remove one first.`;
    $("errors").dataset.last = ""; // a refused press is said every time, not only the first
    updateTicket();
    // Empty the alert and fill it on the next frame, so the same words twice in a row are read again.
    const a = $("errorAlert"), msg = a.textContent;
    a.textContent = "";
    cancelAnimationFrame(S.alertFrame);
    S.alertFrame = requestAnimationFrame(() => { a.textContent = msg; });
    revealOrder();
    return;
  }
  S.legNote = "";
  S.legs.push({ side, type, strike, notional });
  updateTicket();
  revealOrder();
  const l = S.legs[S.legs.length - 1];
  const n = S.legs.length;
  announce(`Added: ${legWords(l)}${legPremium(l)}. ${n} option${n === 1 ? "" : "s"} in this order.`);
}

/**
 * After a price is clicked, bring what changed into view: the reason the order is blocked if
 * it is, otherwise the option just added. On laptop screens the ticket scrolls on its own and
 * these sit below its fold.
 */
function revealOrder() {
  const t = document.querySelector(".ticket");
  if (t.scrollHeight <= t.clientHeight + 1) return; // phones and tall screens: nothing is hidden in the ticket
  const errs = $("errors");
  const el = errs.children.length ? errs : $("legsList").lastElementChild;
  el?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

const legWords = (l) => `${l.side === "B" ? "Buy" : "Write"} ${l.strike}%-strike ${l.type === "C" ? "calls" : "puts"}, size ${pct(l.notional, 0)} of equity`;

/** ", pay $X" for a leg as priced in the current order preview (empty if it can't be priced). */
function legPremium(l) {
  const chk = S.game.check(currentAction());
  const pl = chk.preview?.legs.find((x) => x.side === l.side && x.type === l.type && x.strike === l.strike && Math.abs(x.notional - l.notional) < 1e-9);
  return pl ? `, ${l.side === "B" ? "pay" : "receive"} ${money(pl.n * pl.px)}` : "";
}

/** One polite status message for changes that otherwise happen silently (adding or removing an option). */
function announce(msg) {
  const el = $("orderStatus");
  el.textContent = "";
  // A fresh text node after a frame, so the same message twice in a row is still read.
  cancelAnimationFrame(S.announceFrame);
  S.announceFrame = requestAnimationFrame(() => { el.textContent = msg; });
}

function currentAction() {
  return { stock: S.stockTarget, legs: S.legs.slice() };
}

/** True when this month's order changes nothing (keep the stock, no options). */
function isHold() {
  const g = S.game;
  const keepStock = S.stockTarget === null || Math.abs(S.stockTarget - g.exposure()) < 0.005;
  return keepStock && S.legs.length === 0;
}

function updateTicket() {
  const g = S.game;
  if (!g) return;
  paintSlider();
  const out = $("stockOut");
  const outText = S.stockTarget === null ? `Keep current (${pct(g.exposure(), 0)})` : `Target ${pct(S.stockTarget, 0)}`;
  if (out.textContent !== outText) out.textContent = outText;
  // The slider speaks its own value in words; the output beside it is visual only.
  const sv = Number($("stockSlider").value);
  $("stockSlider").setAttribute("aria-valuetext", S.stockTarget === null
    ? `Keep current, ${pct(g.exposure(), 0)} of equity`
    : sv > 0 ? `Long ${sv}% of equity` : sv < 0 ? `Short ${-sv}% of equity` : "Flat, 0%");
  $("keepBtn").setAttribute("aria-pressed", String(S.stockTarget === null));
  for (const b of document.querySelectorAll(".quick-btns button[data-x]")) {
    b.setAttribute("aria-pressed", String(S.stockTarget !== null && Math.abs(Number(b.dataset.x) / 100 - S.stockTarget) < 1e-9));
  }

  const chk = g.check(currentAction());
  const p = chk.preview;
  const priced = p ? p.legs : [];
  const list = $("legsList");
  list.innerHTML = "";
  S.legs.forEach((l, i) => {
    const li = document.createElement("li");
    const what = legWords(l);
    const pl = priced.find((x) => x.side === l.side && x.type === l.type && x.strike === l.strike && Math.abs(x.notional - l.notional) < 1e-9);
    const prem = pl ? `${l.side === "B" ? "pay" : "receive"} ${money(pl.n * pl.px)}` : "";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove: ${what}`);
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      S.legs.splice(i, 1);
      S.legNote = "";
      updateTicket();
      const n = S.legs.length;
      announce(`Removed: ${what}. ${n ? `${n} option${n === 1 ? "" : "s"} left in this order.` : "No options in this order."}`);
      // The list was rebuilt, so put focus somewhere sensible instead of letting it fall to the page
      // (where Enter would advance the month).
      const left = $("legsList").querySelectorAll("li button");
      (left[i] || left[i - 1] || $("addLeg")).focus();
    });
    const span = document.createElement("span");
    span.innerHTML = `${what}${prem ? ` <span class="leg-prem">· ${prem}</span>` : ""}`;
    li.appendChild(rm);
    li.appendChild(span);
    list.appendChild(li);
  });

  // Before and after this order.
  const S0 = g.S[g.idx];
  const E = g.equity;
  const nowStock = (g.shares * S0) / E;
  const rows = [];
  const diff = (k, a, b, fmt) => {
    const same = Math.abs(a - b) < 0.0005 * Math.max(1, Math.abs(a));
    rows.push(same
      ? `<span class="k">${k}</span><span class="v to wide">${fmt(b)}</span>`
      : `<span class="k">${k}</span><span class="v from">${fmt(a)}</span><span class="v arrow" aria-label="becomes">→</span><span class="v to">${fmt(b)}</span>`);
  };
  if (p) {
    diff("Stock position", nowStock, (p.shares * S0) / E, (v) => pct(v, 0));
    diff("Net exposure (stock + options)", nowStock, p.legs.length ? p.netExp : (p.shares * S0) / E, (v) => pct(v, 0));
    diff("Cash", g.cash, p.cash, (v) => money(v));
    const prem = p.legs.reduce((s, l) => s + (l.side === "W" ? 1 : -1) * l.n * l.px, 0);
    if (p.legs.length) rows.push(`<span class="k">Option premium</span><span class="v to wide">${prem >= 0 ? "receive" : "pay"} ${money(Math.abs(prem))}</span>`);
    if (p.costs > 0.5 || p.spread > 0.5) rows.push(`<span class="k">Trading costs and spread</span><span class="v to wide">${money(p.costs + p.spread)}</span>`);
  }
  $("preview").innerHTML = rows.join("");

  // Errors: the list always shows the current numbers, but the alert fires only when the kind
  // of error changes, not on every slider step that moves a number in the same message.
  const errs = $("errors");
  const errText = [...chk.errors, ...(S.legNote ? [S.legNote] : [])];
  const shown = errText.join("|");
  if (errs.dataset.text !== shown) {
    errs.dataset.text = shown;
    errs.innerHTML = errText.map((e) => `<li>${e}</li>`).join("");
  }
  // A note alone (the four-option limit) doesn't block the order: shown as a note, not an error.
  errs.classList.toggle("note-only", !chk.errors.length);
  // The first reason the order is blocked also shows beside the button, which never scrolls
  // away (the list above is the full, announced copy).
  const why = $("abWhy");
  const whyText = chk.ok ? "" : (chk.errors[0] || "");
  if (why.textContent !== whyText) why.textContent = whyText;
  const key = errText.map((e) => e.replace(/[−+-]?[$]?[\d.,]+%?/g, "#")).join("|");
  if (errs.dataset.last !== key) {
    errs.dataset.last = key;
    cancelAnimationFrame(S.alertFrame);
    $("errorAlert").textContent = errText.join(" ");
    // Emptied once read (emptying isn't announced), so the visible list is the only lasting
    // copy and browse mode doesn't meet each error twice with older numbers.
    clearTimeout(S.alertTimer);
    S.alertTimer = setTimeout(() => { $("errorAlert").textContent = ""; }, 3000);
  }

  const go = $("nextTurn");
  go.disabled = !chk.ok;
  // During the short pause after a month the button is only marked busy, not disabled, so
  // keyboard focus stays on it (a disabled button would drop focus to the page).
  go.setAttribute("aria-disabled", String(!!S.busy));
  const last = g.turn + 1 >= g.turns;
  go.textContent = !chk.ok ? "Fix the order to continue"
    : last ? (S.cfg.blind ? (isHold() ? "Hold and reveal the stock" : "Trade and reveal the stock") : (isHold() ? "Hold and see results" : "Trade and see results"))
      : isHold() ? `Hold, go to month ${g.turn + 2}` : `Trade and go to month ${g.turn + 2}`;
}

function beatFor(t, before, after) {
  const you = after / before - 1;
  const s = change(t.stockReturn);
  const y = change(you);
  const d = after - before;
  let msg = `<strong>Month ${t.turn + 1}:</strong> stock <span class="${s.cls}">${s.text}</span>, you <span class="${y.cls}">${y.text}</span>, ${d >= 0 ? "+" : "−"}${money(Math.abs(d))}.`;
  if (t.marginCall) msg += " <strong>Margin call:</strong> positions were sold.";
  if (S.game.busted) msg += " <strong>Account wiped out.</strong>";
  return msg;
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
  cancelAnimationFrame(S.announceFrame);
  $("orderStatus").textContent = "";
  S.stockTarget = null;
  S.lastToast = beatFor(t, before, t.equityEnd ?? g.equity);
  saveGame();
  if (g.over) finish();
  else renderGame();
}

function runAutopilot() {
  const g = S.game;
  if (!g || g.over) return; // a second click on a finished game does nothing
  const key = $("autoStrat").value;
  const fn = STRATEGIES[key].fn;
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
  saveGame();
  finish();
}

function finish() {
  const g = S.game;
  S.benchmarks = runBenchmarks(S.market, { startIdx: g.startIdx, turns: g.turns }, S.spyMarket);
  // The reveal ceremony runs once, for a blind game finished in this tab.
  S.ceremony = !!S.cfg.blind && !S.replay && !reducedMotion();
  // Replace the #/play entry rather than push one, so Back from the results leaves them.
  if (location.hash !== "#/results") history.replaceState(null, "", "#/results");
  show("results");
  renderResults();
}

// ------------------------------------------------------------------ results

function endCeremony() {
  if (!S.ceremonyOn) return;
  S.ceremonyOn = false;
  clearTimeout(S.ceremonyTimer);
  clearTimeout(S.ceremonyDates);
  $("screen-results").classList.remove("ceremony");
  $("revealSkip").hidden = true;
  if (!S.revealDates) { S.revealDates = true; S.charts.reveal?.rebuild(); }
}

/** Stop any reveal in progress and clear its timers (used between games). */
function resetCeremony() {
  clearTimeout(S.ceremonyTimer);
  clearTimeout(S.ceremonyDates);
  S.ceremonyOn = false;
  S.revealDates = true;
  $("screen-results").classList.remove("ceremony");
  $("revealSkip").hidden = true;
}

function startCeremony() {
  clearTimeout(S.ceremonyTimer);
  clearTimeout(S.ceremonyDates);
  S.ceremonyOn = true;
  S.revealDates = false;
  $("screen-results").classList.add("ceremony");
  $("revealSkip").hidden = false;
  S.ceremonyDates = setTimeout(() => { S.revealDates = true; S.charts.reveal?.rebuild(); }, 900);
  S.ceremonyTimer = setTimeout(endCeremony, 2500);
}

/** One sentence that places the player and says why, from the numbers only. */
function verdictSentence(rows, res, bh) {
  const you = rows.find((r) => r.key === "you");
  const n = rows.length;
  const ties = you.tiedWith.map((k) => rows.find((r) => r.key === k)?.short).filter(Boolean);
  const place = ties.length ? `Tied ${ordinal(you.overall)} of ${n} with ${ties.join(" and ")}` : `${ordinal(you.overall)} of ${n}`;
  const g = S.game;
  const nets = g.log.map((t) => Math.abs(Number.isFinite(t.netExposure) ? t.netExposure : t.exposure));
  const avgExp = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
  const moved = (x) => `${x >= 0 ? "rose" : "fell"} ${pct(Math.abs(x), 0)}`;
  // The reason has to agree with the place: compare against buy and hold's place first.
  const bhRow = rows.find((r) => r.key === "buyHold");
  const ahead = bhRow && you.overall < bhRow.overall;
  const behind = bhRow && you.overall > bhRow.overall;
  const rY = pct(res.totalReturn, 0, true);
  const rB = pct(bh.totalReturn, 0, true);
  // Only the measures that point the same way as the place are quoted as the reason.
  const sharpeTxt = `Sharpe ${num(res.sharpe)} against ${num(bh.sharpe)}`;
  const dropTxt = `worst drop ${pct(res.maxDrawdown, 0)} against ${pct(bh.maxDrawdown, 0)}`;
  const which = (better) => {
    const out = [];
    if (better ? res.sharpe > bh.sharpe : res.sharpe < bh.sharpe) out.push(sharpeTxt);
    if (better ? res.maxDrawdown < bh.maxDrawdown - 0.005 : res.maxDrawdown > bh.maxDrawdown + 0.005) out.push(dropTxt);
    return out.length ? ` (${out.join(", ")})` : "";
  };
  // A margin call sells everything, so it explains the result before anything else does.
  const margin = g.events.find((e) => e.kind === "margin");
  let why;
  if (res.busted) why = "your account was wiped out before the end.";
  else if (Math.abs(res.totalReturn - bh.totalReturn) < 0.005 && Math.abs(res.maxDrawdown - bh.maxDrawdown) < 0.01) why = `you tracked simply holding the stock almost exactly, ${rY} each.`;
  else if (margin) why = `a margin call in month ${margin.turn + 1} sold your positions, and you finished at ${rY} against ${rB} for holding.`;
  else if (avgExp < 0.15) why = `you held mostly cash while the stock ${moved(bh.totalReturn)}.`;
  else if (ahead && res.totalReturn > bh.totalReturn + 0.005) why = `you beat simply holding the stock, ${rY} against ${rB}.`;
  else if (ahead && res.maxDrawdown < bh.maxDrawdown - 0.02) why = `you returned ${rY} against ${rB} for holding, with a smaller worst drop (${pct(res.maxDrawdown, 0)} against ${pct(bh.maxDrawdown, 0)}).`;
  else if (ahead) why = `you returned ${rY} against ${rB} for holding and placed ahead of it on the judged metrics${which(true)}.`;
  else if (behind && res.totalReturn > bh.totalReturn + 0.005) why = `you returned ${rY} against ${rB} for holding, but placed below it on the judged metrics${which(false)}.`;
  else if (behind) why = `simply holding the stock did better, ${rB} against your ${rY}.`;
  else why = `you placed level with simply holding the stock, ${rY} against ${rB}.`;
  return `${place}: ${why}`;
}

/** A coach note. h: its heading level (the one beside the verdict comes before any h2 on the page). */
function noteHtml(n, h = "h3") {
  const badge = n.tone === "good" ? "✓ good" : n.tone === "bad" ? "! watch" : "• note";
  return `<div class="note ${n.tone}"><div class="note-head"><span class="badge ${n.tone}">${badge}</span><${h}>${n.title}</${h}></div><p>${n.text}</p>${n.detail ? `<p class="detail">${n.detail}</p>` : ""}</div>`;
}

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

  // Final values are in place from the first frame; the ceremony only animates covers.
  $("revealEyebrow").textContent = S.replay ? "Replay" : cfg.blind ? "The tape is revealed" : "Game over";
  $("revealTitle").textContent = `${cfg.blind ? "It was " : ""}${p.name} (${cfg.sym})`;
  const regime = p.regime && g.turns >= (S.meta.game_years || 5) * 12 ? ` · ${p.regime}` : "";
  $("revealDatesText").textContent = `${fmtDate(d0)} to ${fmtDate(d1)} · ${g.turns} months${regime}`;
  const sYou = change(res.totalReturn, (v) => pct(v, 0, true));
  const sBh = change(bh.totalReturn, (v) => pct(v, 0, true));
  $("revealSub").innerHTML = `You returned <strong class="${sYou.cls}">${sYou.text}</strong>. Simply holding the stock returned <strong class="${sBh.cls}">${sBh.text}</strong>.${g.busted ? " Your account was wiped out." : ""}`;

  $("tSharpe").textContent = res.busted ? "bust" : num(res.sharpe);
  $("tSharpeSub").textContent = `Buy and hold: ${num(bh.sharpe)}`;
  $("tMdd").textContent = pct(-res.maxDrawdown, 1);
  $("tMddSub").textContent = `Buy and hold: ${pct(-bh.maxDrawdown, 1)}`;
  setChange($("tIrr"), res.irr);
  $("tIrrSub").textContent = `Buy and hold: ${pct(bh.irr, 1, true)}`;
  $("tFinal").textContent = money(res.finalValue);
  $("tFinalSub").textContent = `from $100,000 (${pct(res.totalReturn, 0, true)})`;

  // Scorecard: ranked on all three judged metrics (Sharpe, max drawdown, IRR).
  const ch = S.challenger;
  const chRow = ch ? [{ key: "challenger", short: ch.name, label: `${ch.name} (same tape)`, results: ch.results }] : [];
  const rows = rankStrategies([{ key: "you", short: "You", label: "You", results: res }, ...chRow, ...benches]);
  renderHeadToHead(rows);
  const you = rows.find((r) => r.key === "you");
  $("tRank").textContent = `${you.tiedWith.length ? "Tied " : ""}${ordinal(you.overall)} of ${rows.length}`;
  $("tRankSub").textContent = `Sharpe rank ${you.ranks.sharpe} · return per drawdown rank ${you.ranks.retToDD} · IRR rank ${you.ranks.irr}`;
  $("verdict").textContent = verdictSentence(rows, res, bh);

  const tb = $("scoreTable").querySelector("tbody");
  const sharpeTxt = (x) => (x.busted ? "bust" : num(x.sharpe));
  const chip = (n, what) => `<span class="rk${n === 1 ? " r1" : ""}" title="Rank ${n} of ${rows.length} on ${what}">#${n}</span>`;
  tb.innerHTML = rows.map((r) => {
    const x = r.results;
    const c = STRAT_COLORS[r.key];
    const sw = `<span class="key">${lineKey(c ? `var(${c})` : "transparent", STRAT_DASH[r.key], { width: 18, stroke: r.key === "you" ? 3 : 2.5 })}</span>`;
    const name = r.key === "you" ? "You" : esc(r.short);
    const rtd = x.busted || !Number.isFinite(x.retToDD) ? "–" : num(x.retToDD);
    const tot = change(x.totalReturn);
    return `<tr class="${r.key === "you" ? "you" : r.key === "challenger" ? "ch" : ""}"><td class="num rank">${r.overall}${r.tiedWith.length ? '<span class="tie">tie</span>' : ""}</td><td class="name" title="${esc(r.label)}"><span class="name-in">${sw}<span>${name}</span></span></td>
      <td class="num">${sharpeTxt(x)}${chip(r.ranks.sharpe, "Sharpe")}</td><td class="num xs-hide">${rtd}${chip(r.ranks.retToDD, "return per drawdown")}</td>
      <td class="num">${pct(x.irr, 1, true)}${chip(r.ranks.irr, "IRR")}</td><td class="num">${pct(-x.maxDrawdown, 1)}</td>
      <td class="num opt">${money(x.finalValue)}</td><td class="num opt ${tot.cls}">${tot.text}</td>
      <td class="num opt">${x.busted ? "–" : num(x.sortino)}</td><td class="num opt">${pct(x.vol, 1)}</td><td class="num opt">${num(x.beta)}</td></tr>`;
  }).join("");

  for (const k of ["reveal", "resEquity", "resDd", "resExp"]) if (S.charts[k]) { S.charts[k].destroy(); delete S.charts[k]; }
  const dateLabel = (v) => fmtDate(new Date(v * 1000).toISOString().slice(0, 10));

  // The reveal chart: the game window, in months until the reveal, then in real dates.
  if (S.ceremony) startCeremony(); else { S.revealDates = true; S.ceremonyOn = false; $("revealSkip").hidden = true; $("screen-results").classList.remove("ceremony"); }
  S.ceremony = false;
  const rx = [];
  const rp = [];
  for (let d = g.startIdx; d <= g.endIdx; d++) { rx.push((d - g.startIdx) / TD); rp.push(S.market.price[d]); }
  S.charts.reveal = makeChart({
    el: $("revealChart"), height: () => (isPhone() ? 130 : 160), rightPad: 30, xSpace: 80, xIncrs: [1, 2, 3, 6, 12, 24],
    // Month numbers until the reveal, then ticks at real month starts.
    xSplits: (min, max, incr) => (S.revealDates ? monthTicksFor(g.startIdx, min, max, incr) : null),
    xFmt: (v) => {
      if (!S.revealDates) return `${v}`;
      const d = S.market.dates[Math.round(g.startIdx + v * TD)];
      return d ? fmtMonthYear(d) : "";
    },
    yFmt: (v) => `$${v.toFixed(Math.max(...rp) >= 20 ? 0 : 2)}`, xLabel: "When",
    xLabelFmt: (v) => { const d = S.market.dates[Math.round(g.startIdx + v * TD)]; return S.revealDates && d ? fmtDate(d) : monthsWords(v); },
    series: [{ label: `${cfg.sym} price`, colorVar: "--ink", width: 1.75, fmt: (v) => `$${v.toFixed(2)}` }],
    data: [rx, rp],
  });

  // Versus the benchmarks sits beside the verdict; the rest of the coach below.
  const notes = debrief(g, benches);
  const versus = notes.find((n) => n.title === "Versus the benchmarks");
  $("versusNote").innerHTML = versus ? noteHtml(versus, "h2") : "";
  $("coachNotes").innerHTML = notes.filter((n) => n !== versus).map((n) => noteHtml(n)).join("");

  // Growth chart: you in color and front; benchmarks muted, patterned and labeled at the end.
  const xs = res.dates.map(isoToSec);
  const lines = [{ key: "you", label: "You", eq: g.curve.equity }];
  if (ch) lines.push({ key: "challenger", label: ch.name, eq: ch.game.curve.equity });
  for (const b of benches) if (STRAT_COLORS[b.key]) lines.push({ key: b.key, label: b.short, eq: b.game.curve.equity });
  const order = [...lines.slice(1), lines[0]]; // draw "you" last, on top
  const allEq = lines.flatMap((l) => l.eq).filter((v) => v > 0);
  const useLog = Math.max(...allEq) / Math.min(...allEq) > 4;
  $("resEquitySub").textContent = `${useLog ? "Log scale" : "Linear scale"} · select a name in the legend to hide its line`;
  S.charts.resEquity = makeChart({
    el: $("resEquityChart"), height: () => (isPhone() ? 260 : 320), xTime: true, legendToggle: true, yLog: useLog, yFmt: (v) => money(v, { compact: true }), ySize: 64,
    xLabel: "Date", xLabelFmt: dateLabel, rightPad: isPhone() ? 86 : 108,
    series: order.map((l) => ({
      label: l.label, colorVar: STRAT_COLORS[l.key], fmt: (v) => money(v),
      width: l.key === "you" ? 2.75 : l.key === "challenger" ? 2.25 : 1.5,
      dash: STRAT_DASH[l.key], endLabel: l.label, strong: l.key === "you" || l.key === "challenger",
    })),
    data: [xs, ...order.map((l) => l.eq.map((v) => Math.max(v, 1)))],
  });

  const dds = [drawdownSeries(g.curve.equity), drawdownSeries(benches.find((b) => b.key === "buyHold").game.curve.equity)];
  S.charts.resDd = makeChart({
    el: $("resDdChart"), height: () => (isPhone() ? 190 : 220), xTime: true, yFmt: (v) => pct(v, 0), xLabel: "Date", xLabelFmt: dateLabel,
    yRange: (u, min) => [Math.min(-0.05, min * 1.05), 0],
    series: [
      { label: "Buy & hold", colorVar: "--s2", width: 1.5, dash: [5, 4], fmt: (v) => pct(v, 1) },
      { label: "You", colorVar: "--you", width: 2.25, fillAlpha: 0.12, fmt: (v) => pct(v, 1) },
    ],
    data: [xs, dds[1], dds[0]],
  });

  const mx = g.log.map((t) => t.turn + 1);
  const netOf = (t) => (Number.isFinite(t.netExposure) ? t.netExposure : t.exposure);
  const anyExposure = g.log.some((t) => Math.abs(netOf(t)) > 1e-6);
  $("expEmpty").hidden = anyExposure;
  $("resExpChart").hidden = !anyExposure;
  if (anyExposure) {
    const longs = g.log.map((t) => (netOf(t) > 1e-6 ? netOf(t) : null));
    const shorts = g.log.map((t) => (netOf(t) < -1e-6 ? netOf(t) : null));
    S.charts.resExp = makeChart({
      el: $("resExpChart"), height: () => (isPhone() ? 190 : 220), yFmt: (v) => pct(v, 0), xFmt: (v) => `${v}`, zeroLine: true, xIncrs: [1, 2, 3, 6, 12],
      xRange: () => [0.5, g.log.length + 0.5],
      xLabel: "Month", xLabelFmt: (v) => `${v} of ${g.log.length}`,
      yRange: (u, min, max) => [Math.min(-0.25, (min ?? 0) * 1.1), Math.max(0.25, (max ?? 0) * 1.1)],
      series: [
        { label: "Long", colorVar: "--long", bars: true, fmt: (v) => pct(v, 0) },
        { label: "Short", colorVar: "--short", bars: true, fmt: (v) => pct(v, 0) },
      ],
      data: [mx, longs, shorts],
    });
  }

  // Log
  $("logTable").querySelector("tbody").innerHTML = g.log.map((t) => {
    const legs = t.action.legs.map((l) => `${l.side === "B" ? "Buy" : "Write"} ${l.strike}% ${l.type === "C" ? "call" : "put"} on ${pct(l.notional, 0)}`).join(", ") || "–";
    const yr = t.equityEnd / t.equityStart - 1;
    const sm = change(t.stockReturn);
    const ym = change(yr);
    return `<tr><td>${t.turn + 1}${cfg.blind ? "" : ` · from ${fmtDate(S.market.dates[t.startIdx])}`}</td><td class="num ${sm.cls}">${sm.text}</td>
      <td class="num">${pct(netOf(t), 0)}</td><td>${legs}</td><td class="num">${t.action.legs.length ? money(t.optionPnl) : "–"}</td>
      <td class="num ${ym.cls}">${ym.text}</td><td class="num">${money(t.equityEnd)}</td></tr>`;
  }).join("");
  $("copyMsg").textContent = "";
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderHeadToHead(rows) {
  const card = $("h2hCard");
  const ch = S.challenger;
  card.hidden = !ch;
  if (!ch) return;
  const you = rows.find((r) => r.key === "you");
  const them = rows.find((r) => r.key === "challenger");
  const metrics = [
    { label: "Sharpe ratio", a: you.results.sharpe, b: them.results.sharpe, fmt: (v) => num(v), better: "high" },
    { label: "Max drawdown", a: you.results.maxDrawdown, b: them.results.maxDrawdown, fmt: (v) => pct(-v, 1), better: "low" },
    { label: "IRR", a: you.results.irr, b: them.results.irr, fmt: (v) => pct(v, 1, true), better: "high" },
  ];
  let wins = 0;
  let losses = 0;
  const body = metrics.map((m) => {
    const a = Number.isFinite(m.a) ? m.a : -Infinity;
    const b = Number.isFinite(m.b) ? m.b : -Infinity;
    const youWin = m.better === "high" ? a > b + 1e-12 : a < b - 1e-12;
    const theyWin = m.better === "high" ? b > a + 1e-12 : b < a - 1e-12;
    wins += youWin ? 1 : 0;
    losses += theyWin ? 1 : 0;
    return `<tr><td>${m.label}</td><td class="num ${youWin ? "win" : ""}">${m.fmt(m.a)}${youWin ? " ✓" : ""}</td><td class="num ${theyWin ? "win" : ""}">${m.fmt(m.b)}${theyWin ? " ✓" : ""}</td></tr>`;
  }).join("");
  const verdict = you.overall < them.overall ? `You win, placing ${ordinal(you.overall)} against ${ordinal(them.overall)} overall.`
    : you.overall > them.overall ? `${esc(ch.name)} wins, placing ${ordinal(them.overall)} against your ${ordinal(you.overall)} overall.`
      : `Dead heat: you both placed ${ordinal(you.overall)} overall.`;
  $("h2hBody").innerHTML = `<p class="h2h-verdict">${verdict} <span class="muted">You took ${wins} of 3 judged metrics, ${esc(ch.name)} took ${losses}.</span></p>
    <div class="table-wrap"><table class="score"><thead><tr><th>Metric</th><th class="num">You</th><th class="num">${esc(ch.name)}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function challengeUrl() {
  const raw = ($("challengeName").value || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 20);
  const cfg = { ...S.cfg, by: raw || "A friend" };
  return `${location.origin}${location.pathname}#/challenge/${encodeReplay(cfg, S.actions)}`;
}

/** Copy to the clipboard first; on phones, offer the share sheet on top. */
async function shareLink(url, copiedMsg, title) {
  try {
    await navigator.clipboard.writeText(url);
    $("copyMsg").textContent = copiedMsg;
  } catch {
    $("copyMsg").innerHTML = `Copy this link: <a href="${esc(url)}">${esc(url.slice(0, 60))}…</a>`;
  }
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    navigator.share({ title, url }).catch(() => {});
  }
}

function copyChallenge() {
  return shareLink(challengeUrl(), `Challenge link copied. Your friend gets the same ${S.cfg.blind ? "blind " : ""}tape, with your score hidden until they finish.`, "Blind Tape challenge");
}

function copyReplay() {
  return shareLink(replayUrl(), "Replay link copied.", "Blind Tape replay");
}

/** Rebuild a challenger's game from its link and attach it (hidden until the end). */
async function attachChallenger(code) {
  const { cfg, actions } = decodeReplay(code);
  const clean = typeof cfg.by === "string" ? cfg.by.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 20) : "";
  const name = clean || "A friend";
  const cg = new Game(S.market, { startIdx: S.game.startIdx, turns: S.game.turns });
  for (const a of actions) {
    if (cg.over) break;
    if (!cg.check(a).ok) throw new Error("This challenge doesn't match the data (it may be from an older version).");
    cg.play(a);
  }
  if (!cg.over) throw new Error("This challenge link is incomplete.");
  S.challenger = { name, results: cg.results(), game: cg };
  S.challengeCode = code;
}

async function openChallenge(code, seq = routeSeq, from = null) {
  // Opened from the game screen, the entry behind the link is that game's #/play: step back
  // onto it, so history never holds two #/play entries in a row (the first Back would do nothing).
  // Never on the entry the tab opened on: what is behind it isn't this page's.
  const fromGame = S.screen === "game" && !history.state?.landing;
  // After opening, step back only from a link just opened (no state yet) on top of the game's
  // #/play. Reached by Back or Forward, or pasted behind another link still loading, the entry
  // behind it is something else, which would then be routed (and could reopen another link).
  const stepBack = fromGame && !history.state && from === "#/play";
  // Back to the link of the challenge being played (it stays in history when the player moved
  // on while it loaded) carries on with that game instead of starting it again. A finished one
  // only does so from that leftover entry: opening its link again starts a new attempt.
  if (code === S.challengeCode && S.game && (!S.game.over || history.state?.challenge)) {
    if (seq !== routeSeq) return;
    history.replaceState(null, "", "#/play");
    if (fromGame && !S.game.over) { history.back(); return; }
    return routeNow(seq);
  }
  // Only one game is kept, so ask before a challenge replaces a game in progress (a damaged
  // link replaces nothing, so it goes straight to its error). On a No, go back to where the
  // player was, or show home with its Resume card.
  if (seq !== routeSeq) return; // a newer route is queued: it reads this same hash and asks once
  let linkOk = true;
  try {
    const r = decodeLink(code, "challenge");
    validateReplayCfg(r.cfg, r.actions, "challenge");
  } catch { linkOk = false; }
  if (linkOk && !okToReplace("Open this challenge?")) {
    if (seq !== routeSeq) return;
    // A link just opened here (no state yet): the page the player was on is behind it. The entry
    // the tab opened on, or one already opened and reached again by Back or Forward, shows home
    // in place.
    if (!history.state) { history.back(); return; }
    history.replaceState(history.state.landing ? { landing: true } : null, "", "#/");
    return routeNow(seq);
  }
  // Mark the entry, so Back to it (if the player moves on while it loads) is told apart from
  // opening the link again.
  if (seq === routeSeq) history.replaceState({ ...history.state, challenge: true }, "");
  const saved = { cfg: S.cfg, market: S.market, spyMarket: S.spyMarket, game: S.game, actions: S.actions, benchmarks: S.benchmarks, replay: S.replay, challenger: S.challenger, challengeCode: S.challengeCode };
  try {
    const { cfg, actions } = decodeLink(code, "challenge");
    validateReplayCfg(cfg, actions, "challenge");
    await setupGame({ ...cfg, by: undefined });
    await attachChallenger(code);
    clearError();
    S.replay = false;
    ownSave();
    saveGame();
    if (seq !== routeSeq) return; // the player has already moved on; the challenge is kept for Resume
    history.replaceState(null, "", "#/play");
    if (stepBack) history.back();
    show("game");
    renderGame(true);
  } catch (e) {
    Object.assign(S, saved);
    for (const k of Object.keys(S.charts)) { S.charts[k].destroy(); delete S.charts[k]; }
    fatal(e, { quiet: true });
    if (seq !== routeSeq) return;
    await loadHomeGame(true); // home offers the game #/ would
    if (seq !== routeSeq) return;
    show("home");
    renderResume();
  }
}

function replayUrl() {
  const code = encodeReplay(S.cfg, S.actions);
  return `${location.origin}${location.pathname}#/replay/${code}`;
}

async function openReplay(code, seq = routeSeq) {
  // Snapshot the current game so a broken replay link can't replace a game in progress.
  const saved = { cfg: S.cfg, market: S.market, spyMarket: S.spyMarket, game: S.game, actions: S.actions, benchmarks: S.benchmarks, replay: S.replay, challenger: S.challenger, challengeCode: S.challengeCode };
  try {
    const { cfg, actions } = decodeLink(code, "replay");
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
    if (seq !== routeSeq) return;
    show("results");
    renderResults();
  } catch (e) {
    Object.assign(S, saved);
    for (const k of Object.keys(S.charts)) { S.charts[k].destroy(); delete S.charts[k]; }
    fatal(e, { quiet: true });
    if (seq !== routeSeq) return;
    await loadHomeGame(true); // home offers the game #/ would
    if (seq !== routeSeq) return;
    show("home");
    renderResume();
  }
}

function validateReplayCfg(cfg, actions, kind = "replay") {
  const fullTurns = (S.meta.game_years || 5) * 12;
  const bad = (m) => { throw new Error(`This ${kind} link isn't valid (${m}).`); };
  if (!cfg || typeof cfg !== "object") bad("no game settings");
  if (!poolInfo().some((p) => p.symbol === cfg.sym)) bad("unknown stock");
  if (cfg.fullTurns !== fullTurns) bad("different game length");
  if (![12, fullTurns].includes(cfg.turns)) bad("unsupported number of months");
  if (!Number.isInteger(cfg.startTurn) || cfg.startTurn < 0 || cfg.startTurn > fullTurns - cfg.turns) bad("bad start month");
  if (typeof cfg.end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.end) || cfg.end > S.meta.as_of) bad("bad end date");
  if (!Array.isArray(actions) || actions.length > cfg.turns) bad("bad action list");
  if (cfg.by !== undefined && (typeof cfg.by !== "string" || cfg.by.length > 20)) bad("bad name");
  cfg.blind = !!cfg.blind;
}

// ------------------------------------------------------------------ how it works

// The reader's choices on How it works, kept in this browser: how much detail is open, and
// whether short definitions of the jargon show inline. initHow() runs before the first route,
// so the page is never shown in one state and then switched to another.
const HOW_DEPTH_KEY = "bt-how-depth"; // "quick" (summaries, folds closed) or "full" (folds open)
const HOW_TERMS_KEY = "bt-how-terms"; // "on" or "off"
const QUICK_TURNS = 12; // a quick round's months, as startNewGame() plays it

function initHow() {
  setHowDepth(load(HOW_DEPTH_KEY) === "full" ? "full" : "quick");
  setHowTerms(load(HOW_TERMS_KEY) === "on");
  for (const b of document.querySelectorAll("[data-how-depth]")) {
    b.addEventListener("click", () => {
      const depth = b.dataset.howDepth;
      setHowDepth(depth); // pressing the current choice again re-folds (or re-opens) every section
      store(HOW_DEPTH_KEY, depth);
      howSay(depth === "full" ? "Full detail: every section is open." : "Quick tour: summaries only. Open any section for more.");
    });
  }
  $("howTerms").addEventListener("click", () => {
    const on = $("howTerms").getAttribute("aria-pressed") !== "true";
    setHowTerms(on);
    store(HOW_TERMS_KEY, on ? "on" : "off");
    howSay(on ? "Term definitions are shown." : "Term definitions are hidden.");
  });
  renderHowNumbers();
}

/** Quick closes every fold, Full opens every one; the reader can still toggle each after. */
function setHowDepth(depth) {
  $("screen-how").dataset.depth = depth;
  for (const b of document.querySelectorAll("[data-how-depth]")) b.setAttribute("aria-pressed", String(b.dataset.howDepth === depth));
  for (const d of document.querySelectorAll("#screen-how details.how-more")) d.open = depth === "full";
}

function setHowTerms(on) {
  $("screen-how").dataset.terms = on ? "on" : "off";
  $("howTerms").setAttribute("aria-pressed", String(on));
}

/** Say a change politely. The same words twice in a row get a trailing space so they are read again. */
function howSay(text) {
  const n = $("howViewMsg");
  n.textContent = n.textContent === text ? `${text}\u00a0` : text;
}

/**
 * By the numbers: every value comes from the engine's constants, or from the data index once it
 * is in (failed: it couldn't be loaded). The tiles keep their size, so filling in the date later
 * doesn't move the page under a reader.
 */
function renderHowNumbers(failed = false) {
  const m = S.meta;
  const R = RULES;
  const months = ((m && m.game_years) || 5) * 12; // as startNewGame() counts a full challenge
  const k = R.strikes;
  const judged = RANK_METRICS.map((x) => x.label.replace("Return/", "return per ")).join(", ");
  const stats = [
    ["Starting stake", money(R.stake), "No deposits or withdrawals"],
    ["Full challenge", `${months} months`, `Or a ${QUICK_TURNS}-month quick round`],
    ["Each turn", `${R.turnDays} days`, "Trading days, valued at every close"],
    ["Strikes", `${k.length}`, `${k[0]}% to ${k[k.length - 1]}% of the price, up to ${R.maxLegs} options a month`],
    ["Net exposure", `−${R.maxShort * 100}% to +${R.maxLong * 100}%`, "Stock plus option delta"],
    ["Stock trade cost", `${R.stockCostBps / 100}%`, `Option half-spread: ${SPREAD.halfPct * 100}% of the premium, at least ${SPREAD.minHalfOfSpot * 100}% of the price`],
    ["Benchmarks", `${Object.keys(STRATEGIES).length + 1}`, "Same prices, same costs"], // + the S&P 500's buy and hold
    ["Judged on", `${RANK_METRICS.length} metrics`, judged],
    ["Data through", m ? fmtDate(m.as_of) : "–",
      m ? `${Object.keys(m.series).length} series, refreshed every weekday` : failed ? "The market data didn't load" : "Loading market data"],
  ];
  $("howNumbers").innerHTML = stats.map(([label, value, sub]) =>
    `<div class="how-stat"><dt>${label}</dt><dd class="how-stat-value num">${value}</dd><dd class="how-stat-sub">${sub}</dd></div>`).join("");
}

// ------------------------------------------------------------------ data page

function renderDataPage() {
  const m = S.meta;
  const stale = isStale(m);
  const ok = '<span class="status-ok"><span aria-hidden="true">✓</span> up to date</span>';
  const bad = (t) => `<span class="status-stale"><span aria-hidden="true">⚠</span> ${t}</span>`;
  $("dataLede").innerHTML = `Daily closes through <strong>${fmtDate(m.as_of)}</strong>. Last data change committed ${m.updated_at ? m.updated_at.replace("T", " ").replace("Z", " UTC") : "–"}. Status: ${stale ? bad("stale: the last refresh had problems") : ok}.`;
  const rows = Object.entries(m.series).map(([, s]) => {
    const isBad = s.stale || (m.failures && m.failures[s.symbol]);
    return `<tr><td>${s.symbol}</td><td>${s.source}</td><td class="num">${s.rows.toLocaleString("en-US")}</td><td class="num">${s.first}</td><td class="num">${s.last}</td><td>${isBad ? bad("stale") : '<span class="status-ok"><span aria-hidden="true">✓</span> ok</span>'}</td></tr>`;
  });
  $("dataTable").querySelector("tbody").innerHTML = rows.join("");
  const repo = m.repo || "cartermburke/FMKT256-AI-Proj";
  $("dataLinks").innerHTML = `<a href="https://github.com/${repo}/actions/workflows/update-data.yml">Update job run history</a> · <a href="https://github.com/${repo}/commits/">Commit history (data refreshes are "data: refresh prices…")</a> · <a href="https://github.com/${repo}/blob/HEAD/config/tickers.json">Ticker config</a>${m.run_url ? ` · <a href="${m.run_url}">Latest data run</a>` : ""}`;
}
