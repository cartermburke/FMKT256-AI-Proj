# Blind Tape: a five-year stock & options trading challenge

**Play it:** https://fmkt256-ai-proj.vercel.app/ (no login, works on desktop and phone)

FMKT 256 (Duke, Fall 2026) AI extra-credit project: prompt 1, a finance app (trading game).
Built with Claude (Anthropic) as the AI pair-programmer. Academic exercise, not investment advice.

## The game

- You start with **$100,000**, fixed (no deposits or withdrawals).
- You get a stock drawn at random from real market history. In **blind mode** its ticker and dates are hidden and the price is rebased to 100, so nobody can win from memory.
- You trade it **one month (21 trading days) at a time** over the most recent **5 years** (60 turns), or a random 12-month slice in a quick round:
  - **Stock:** −100% (short) to +150% (long on margin) of equity.
  - **Options:** one-month European calls and puts at 90/95/100/105/110% strikes. Writes must be covered or cash-secured.
- At the end the stock is revealed and you're scored on **Sharpe ratio, maximum drawdown and IRR**, plus Sortino, volatility and beta. Six auto-played benchmarks run on the same data with the same costs: buy & hold, the S&P 500, a covered call, a protective put, a 200-day trend rule, and T-bills.
- A **coach's debrief** explains what drove your result. A **replay link** lets anyone reproduce your exact game, and a **challenge link** lets a friend play the same blind tape and be ranked against you.
- Each month the order ticket shows your position before and after the order, the bar at the bottom names the action ("Hold, go to month 4" or "Trade and go to month 4"), and a one-line summary follows every month. Tap a bid to sell an option or an ask to buy it.
- A blind game ends with a short reveal (the name and dates come out, then your verdict in words). It is skippable and turns off with the system's reduce-motion setting.
- The game in progress is kept in your browser, so a reload picks up where you left off.

Full rules, the option-pricing model and the metric definitions are on the site's *How it works* page.

## How data gets in and stays current

```
config/tickers.json ──► GitHub Actions: update-data (weekdays 22:30 UTC, on config change, or manual)
                          └─ scripts/fetch_data.py
                               yfinance → Yahoo chart API → Nasdaq API (→ FRED for T-bills, Tiingo if keyed)
                               validate: no gaps > 10 days, no NaN, ranges, split check, enough history
                               write site/data/prices/*.json + site/data/meta.json only if changed
                          └─ commit "data: refresh prices through <date>" ─► Vercel redeploys the site
site/ (static) ──► loads data/*.json ──► the game window always ends at the latest close
```

- **Historical import:** the first run downloads about 7 years of daily adjusted closes for every stock, plus SPY, the VIX (^VIX) and the 13-week T-bill yield (^IRX).
- **Updates:** every weekday after the close the new bar is appended and the site is redeployed. The 5-year window rolls forward by itself.
- **Add a stock with no code changes:** add `{"symbol": "AAPL", "name": "Apple", "regime": "..."}` to `config/tickers.json` and push. The workflow downloads its history and it joins the pool.
- **Failure handling:** if every source fails for a series, the last good file is kept, `meta.json` is flagged `stale`, and the site shows a banner. The site's *Data* page shows the per-series status.

## Repository layout

| Path | What |
|---|---|
| `site/index.html`, `site/app.js`, `site/ui/` | UI: vanilla ES modules, no build step |
| `site/engine/` | Pure-JS engine: `game.js` (rules, margin, settlement), `options.js` (Black-Scholes, IV model, spreads), `market.js` (alignment, realized vol, SMA), `metrics.js` (Sharpe, Sortino, MDD, XIRR, beta), `strategies.js` (benchmarks), `coach.js`, `replay.js`, `rng.js` |
| `site/vendor/` | uPlot 1.6.32 (MIT) and the Public Sans and IBM Plex Mono fonts (SIL OFL 1.1, licenses alongside), self-hosted so the site has no CDN dependency |
| `site/data/` | Price data written by the workflow |
| `scripts/fetch_data.py` | Downloader and validator |
| `.github/workflows/` | `update-data.yml` (fetch, validate, commit data), `ci.yml` (unit tests on every push) |
| `vercel.json` | Vercel serves `site/` as a static site and redeploys on every commit |
| `tests/` | Unit tests, pandas cross-check, Playwright end-to-end test |
| `submission/` | Script that builds the class submission PDF |

## Run and test locally

```bash
python3 -m http.server 8000 --directory site      # then open http://localhost:8000
```

```bash
node --test tests/*.test.mjs                      # engine unit tests
```

```bash
node tests/export_curves.mjs && python3 tests/check_metrics.py   # independent pandas recomputation of every metric
```

```bash
node tests/e2e.mjs                                # Playwright: plays games through the real UI, saves screenshots
```

## Key modelling choices

- **Implied vol:** `IV_atm² = RV63(stock)² + (0.88·VIX/100)² − RV63(SPY)²`, then a smile `IV(K) = IV_atm·(1 − slope·ln(K/S))`: slope 3.0 on both sides for the index, and for single stocks 1.25 on the put side with a flat call wing. This adds the market's at-the-money variance risk premium once, in variance units, and prices out-of-the-money puts richer than calls. Two earlier versions failed reality checks and were replaced: one made covered calls dominate almost every stock, and the other let a SPY buy-write beat SPY by 46 points.
- **Leverage and ranking:** net exposure (stock plus option delta) is capped at −100%/+150% per order, and all option legs together at 200% of equity notional. Written puts must be secured by cash left after the order. The overall rank is the average of the Sharpe, return-per-unit-of-drawdown and IRR ranks. Raw drawdown isn't averaged in, because it would reward tiny positions.
- **Frictions:**
  - 5 bp on stock trades.
  - Option half-spread of 2.5% of premium, with a minimum of 5 bp of spot.
  - Debit pays T-bill + 1.5%.
  - Shorts pay 0.5% a year to borrow.
  - Maintenance margin is 25%, checked at every daily close.
- **Limitations:** model option prices (a simple two-parameter smile, not fitted to each stock; earnings days aren't modelled), monthly decisions at the close, fractional shares. See *How it works*.
