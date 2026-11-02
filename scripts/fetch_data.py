#!/usr/bin/env python3
"""Download daily price history for the Blind Tape game and write site/data/.

Runs on GitHub Actions (open internet) on a weekday schedule, on manual dispatch,
and whenever config/tickers.json changes. Adding a ticker to the config is all it
takes to add it to the game -- no code changes.

Sources, tried in order per symbol:
  1. yfinance (Yahoo Finance, dividend/split-adjusted closes)
  2. Yahoo Finance chart API called directly (adjclose field)
  3. Nasdaq.com historical API (split-adjusted closes; stocks/ETFs/VIX)
  4. FRED DTB3 (3-month T-bill rate) -- only for ^IRX
  5. Tiingo (adjClose) -- only if a TIINGO_API_KEY secret is configured

Validation (per series): dates strictly increasing, no NaN/inf, prices > 0
(rates >= 0), no calendar gap > 10 days, enough history for the game window.
If a refresh fails, the last good file is kept and meta.json is flagged stale.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import math
import os
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "tickers.json"
OUT_DIR = ROOT / "site" / "data"
PRICE_DIR = OUT_DIR / "prices"
META = OUT_DIR / "meta.json"

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def log(msg: str) -> None:
    print(msg, flush=True)


NY = ZoneInfo("America/New_York")


def last_complete_session() -> dt.date:
    """Latest date whose daily bar is final: today after 5pm New York time, else yesterday."""
    now = dt.datetime.now(NY)
    return now.date() if now.hour >= 17 else now.date() - dt.timedelta(days=1)


def drop_unfinished(s: pd.Series) -> pd.Series:
    """Drop an in-progress intraday bar so a run during market hours never publishes it as a close."""
    cutoff = pd.Timestamp(last_complete_session())
    return s[s.index <= cutoff]


def stabilize(new: pd.Series, old_path: Path, kind: str) -> pd.Series:
    """Keep previously published values when the provider only re-rounds them.

    yfinance's adjusted closes jitter by ~1e-6 between pulls. If every overlapping value
    matches the published file within 5e-5 (relative), reuse the old values and append only
    new dates, so unchanged data produces no commit and replay links stay exact. A real
    re-adjustment (e.g. after a dividend, typically ~1e-3 or more) replaces the series.
    """
    if not old_path.exists():
        return new
    try:
        old = json.loads(old_path.read_text())
        old_s = pd.Series(old["close"], index=pd.to_datetime(old["dates"]), dtype="float64")
    except Exception:  # noqa: BLE001
        return new
    common = new.index.intersection(old_s.index)
    if len(common) < 0.9 * len(old_s):
        return new
    a, b = new.loc[common].to_numpy(), old_s.loc[common].to_numpy()
    denom = 1.0 if kind == "rate" else 1e-12
    rel = abs(a - b) / (abs(b) + denom) if kind != "rate" else abs(a - b)
    if rel.max() < (5e-5 if kind != "rate" else 1e-4):
        merged = new.copy()
        merged.loc[common] = old_s.loc[common]
        return merged
    return new


# --------------------------------------------------------------------------- sources

def from_yfinance(symbol: str, start: dt.date) -> pd.Series:
    import yfinance as yf  # imported lazily so other sources work without it

    df = yf.download(symbol, start=start.isoformat(), auto_adjust=True,
                     progress=False, threads=False, multi_level_index=False)
    if df is None or df.empty or "Close" not in df:
        raise RuntimeError("yfinance returned no data")
    s = df["Close"].dropna()
    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
    return s.astype(float)


def from_yahoo_chart(symbol: str, start: dt.date) -> pd.Series:
    p1 = int(dt.datetime.combine(start, dt.time()).replace(tzinfo=dt.timezone.utc).timestamp())
    p2 = int(time.time()) + 86400
    last_err = None
    for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{requests.utils.quote(symbol)}"
               f"?period1={p1}&period2={p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true")
        try:
            r = requests.get(url, headers=UA, timeout=30)
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            ts = res["timestamp"]
            ind = res["indicators"]
            vals = (ind.get("adjclose") or [{}])[0].get("adjclose") or ind["quote"][0]["close"]
            gmtoff = res.get("meta", {}).get("gmtoffset", 0) or 0
            idx = pd.to_datetime([t + gmtoff for t in ts], unit="s").normalize()
            s = pd.Series(vals, index=idx, dtype="float64").dropna()
            if s.empty:
                raise RuntimeError("empty series")
            return s
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"yahoo chart failed: {last_err}")


def from_nasdaq(symbol: str, start: dt.date) -> pd.Series:
    if symbol == "^IRX":
        raise RuntimeError("not on nasdaq")
    sym, assetclass = symbol, "stocks"
    if symbol == "^VIX":
        sym, assetclass = "VIX", "index"
    elif symbol in ("SPY", "QQQ", "IWM", "DIA"):
        assetclass = "etf"
    url = (f"https://api.nasdaq.com/api/quote/{sym}/historical?assetclass={assetclass}"
           f"&fromdate={start.isoformat()}&todate={dt.date.today().isoformat()}&limit=9999")
    r = requests.get(url, headers={**UA, "Origin": "https://www.nasdaq.com",
                                   "Referer": "https://www.nasdaq.com/"}, timeout=30)
    r.raise_for_status()
    rows = (((r.json() or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
    if not rows:
        raise RuntimeError("nasdaq returned no rows")
    idx = pd.to_datetime([row["date"] for row in rows], format="%m/%d/%Y")
    vals = [float(str(row["close"]).replace("$", "").replace(",", "")) for row in rows]
    return pd.Series(vals, index=idx, dtype="float64").sort_index()


def from_fred_dtb3(symbol: str, start: dt.date) -> pd.Series:
    if symbol != "^IRX":
        raise RuntimeError("FRED only used for ^IRX")
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd={start.isoformat()}"
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    df.columns = ["date", "value"]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna()
    return pd.Series(df["value"].values, index=pd.to_datetime(df["date"]), dtype="float64")


def from_tiingo(symbol: str, start: dt.date) -> pd.Series:
    key = os.environ.get("TIINGO_API_KEY")
    if not key:
        raise RuntimeError("no TIINGO_API_KEY")
    if symbol.startswith("^"):
        raise RuntimeError("tiingo has no index data")
    url = f"https://api.tiingo.com/tiingo/daily/{symbol}/prices?startDate={start.isoformat()}&token={key}"
    r = requests.get(url, headers={"Content-Type": "application/json"}, timeout=30)
    r.raise_for_status()
    rows = r.json()
    idx = pd.to_datetime([row["date"][:10] for row in rows])
    return pd.Series([row["adjClose"] for row in rows], index=idx, dtype="float64")


SOURCES = [
    ("yfinance", from_yfinance),
    ("yahoo-chart", from_yahoo_chart),
    ("nasdaq", from_nasdaq),
    ("fred-dtb3", from_fred_dtb3),
    ("tiingo", from_tiingo),
]


# --------------------------------------------------------------------------- validation

def validate(symbol: str, s: pd.Series, kind: str, min_days: int) -> list[str]:
    problems = []
    if len(s) < min_days:
        problems.append(f"only {len(s)} rows (< {min_days})")
    if not s.index.is_monotonic_increasing or s.index.has_duplicates:
        problems.append("dates not strictly increasing")
    vals = s.to_numpy()
    if any(not math.isfinite(v) for v in vals):
        problems.append("non-finite values")
    if kind == "rate":
        # T-bill yields dipped slightly below zero in 2020-21, so allow small negatives.
        if (s < -1).any() or (s > 25).any():
            problems.append("rate outside [-1, 25]%")
    elif (s <= 0).any():
        problems.append("non-positive prices")
    gaps = s.index.to_series().diff().dt.days.dropna()
    if len(gaps) and gaps.max() > 10:
        problems.append(f"calendar gap of {int(gaps.max())} days at {gaps.idxmax().date()}")
    if kind != "rate" and not symbol.startswith("^") and len(s) > 1:
        rets = s.pct_change().dropna()
        bad = rets[(rets <= -0.6) | (rets >= 1.5)]
        if len(bad):
            problems.append(f"suspicious 1-day move {bad.iloc[0]:+.0%} at {bad.index[0].date()} (unadjusted split?)")
    return problems


def fetch_one(symbol: str, kind: str, start: dt.date, min_days: int) -> tuple[pd.Series, str]:
    errors = []
    for name, fn in SOURCES:
        try:
            s = fn(symbol, start)
            s = s[~s.index.duplicated(keep="last")].sort_index()
            s = s[s.index >= pd.Timestamp(start)]
            s = drop_unfinished(s)
            probs = validate(symbol, s, kind, min_days)
            if probs:
                raise RuntimeError("; ".join(probs))
            return s, name
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {str(e)[:160]}")
            log(f"  [{symbol}] {name} failed: {str(e)[:160]}")
    raise RuntimeError(" | ".join(errors))


# --------------------------------------------------------------------------- main

def series_payload(symbol: str, name: str, kind: str, source: str, s: pd.Series) -> dict:
    nd = 4 if kind == "rate" else 4
    return {
        "symbol": symbol,
        "name": name,
        "kind": kind,
        "source": source,
        "adjusted": source in ("yfinance", "yahoo-chart", "tiingo") and kind == "price",
        "dates": [d.strftime("%Y-%m-%d") for d in s.index],
        "close": [round(float(v), nd) for v in s.to_numpy()],
    }


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    years = int(cfg.get("history_years", 7))
    start = dt.date.today() - dt.timedelta(days=int(365.25 * years))
    # The game needs game_years*12 turns of 21 days plus 200 days for the 200-day average.
    min_days = int(cfg.get("game_years", 5)) * 12 * 21 + 200 + 40

    targets = [(t["symbol"], t["symbol"].replace("^", ""), t.get("name", t["symbol"]), "price")
               for t in cfg["pool"]]
    if cfg.get("benchmark") and cfg["benchmark"] not in {t[0] for t in targets}:
        b = cfg["benchmark"]
        targets.append((b, b, b, "price"))
    for a in cfg.get("aux", []):
        targets.append((a["symbol"], a["file"], a.get("name", a["symbol"]),
                        "rate" if a.get("kind") == "rate" else "price"))

    PRICE_DIR.mkdir(parents=True, exist_ok=True)
    old_meta = json.loads(META.read_text()) if META.exists() else {}
    old_series = old_meta.get("series", {})
    series_meta, failures, changed = {}, {}, False

    for symbol, fname, name, kind in targets:
        log(f"Fetching {symbol} ...")
        path = PRICE_DIR / f"{fname}.json"
        try:
            s, source = fetch_one(symbol, kind, start, min_days)
            s = stabilize(s, path, kind)
            payload = series_payload(symbol, name, kind, source, s)
            text = json.dumps(payload, separators=(",", ":"))
            if not path.exists() or path.read_text() != text:
                path.write_text(text)
                changed = True
            series_meta[fname] = {"symbol": symbol, "source": source, "rows": len(s),
                                  "first": payload["dates"][0], "last": payload["dates"][-1]}
            log(f"  ok via {source}: {len(s)} rows {payload['dates'][0]} -> {payload['dates'][-1]}")
        except Exception as e:  # noqa: BLE001
            failures[symbol] = str(e)[:500]
            if fname in old_series and path.exists():
                series_meta[fname] = {**old_series[fname], "stale": True}
                log(f"  FAILED, keeping last good data for {symbol}")
            else:
                log(f"  FAILED with no prior data for {symbol}")

    # The game's "as of" date is the latest date shared by the benchmark and aux series.
    lasts = [m["last"] for m in series_meta.values() if m.get("symbol") in
             {cfg.get("benchmark")} | {a["symbol"] for a in cfg.get("aux", [])}]
    as_of = min(lasts) if lasts else None
    today = dt.date.today()
    stale = bool(failures) or (as_of is None) or \
        (today - dt.date.fromisoformat(as_of)).days > 5

    meta = {
        "as_of": as_of,
        "updated_at": old_meta.get("updated_at"),
        "stale": stale,
        "failures": failures,
        "series": series_meta,
        "pool": [t["symbol"] for t in cfg["pool"]],
        "pool_info": [{"symbol": t["symbol"], "name": t.get("name", t["symbol"]),
                       "regime": t.get("regime", "")} for t in cfg["pool"]],
        "benchmark": cfg.get("benchmark"),
        "game_years": cfg.get("game_years", 5),
        "repo": os.environ.get("GITHUB_REPOSITORY"),
        "run_url": (f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}"
                    f"/actions/runs/{os.environ['GITHUB_RUN_ID']}"
                    if os.environ.get("GITHUB_RUN_ID") else None),
    }
    material = {k: meta[k] for k in ("as_of", "stale", "failures", "series", "pool", "pool_info")}
    old_material = {k: old_meta.get(k) for k in material}
    if changed or material != old_material:
        meta["updated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        META.write_text(json.dumps(meta, indent=2))
        log(f"meta.json written (as_of={as_of}, stale={stale})")
    else:
        log("No data changes.")

    if failures:
        log("FAILURES:\n" + "\n".join(f"  {k}: {v}" for k, v in failures.items()))
    # Fail the run only if a required series has never been fetched.
    missing = [t[0] for t in targets if t[1] not in series_meta]
    if missing:
        log(f"ERROR: no data at all for {missing}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
