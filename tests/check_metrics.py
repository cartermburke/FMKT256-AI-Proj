#!/usr/bin/env python3
"""Independent cross-check of the JavaScript metrics using pandas/numpy.

Run `node tests/export_curves.mjs` first; it writes tests/artifacts/curves.json with
each strategy's daily equity curve and the metrics the browser computed. This script
recomputes Sharpe, Sortino, max drawdown, IRR (CAGR, Actual/365), volatility and beta
from scratch and fails if any differ by more than 1e-6.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

TOL = 1e-6
path = Path(__file__).parent / "artifacts" / "curves.json"
rows = json.loads(path.read_text())

bad = 0
for r in rows:
    eq = pd.Series(r["equity"], index=pd.to_datetime(r["dates"]))
    rets = eq.pct_change().dropna().to_numpy()
    ex = rets - np.asarray(r["rf_daily"])
    sd = ex.std(ddof=1)
    sharpe = 0.0 if sd <= 1e-12 and abs(ex.mean()) <= 1e-12 else ex.mean() / sd * math.sqrt(252)
    dd = math.sqrt(np.mean(np.minimum(ex, 0) ** 2))
    sortino = 0.0 if dd <= 1e-12 and abs(ex.mean()) <= 1e-12 else ex.mean() / dd * math.sqrt(252)
    mdd = float((1 - eq / eq.cummax()).max())
    years = (eq.index[-1] - eq.index[0]).days / 365
    irr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1 if eq.iloc[-1] > 0 else -1.0
    vol = rets.std(ddof=1) * math.sqrt(252)
    spy_rets = pd.Series(r["spy"]).pct_change().dropna().to_numpy()
    beta = np.cov(rets, spy_rets, ddof=1)[0, 1] / np.var(spy_rets, ddof=1)
    ours = {"sharpe": sharpe, "sortino": sortino, "maxDrawdown": mdd, "irr": irr, "vol": vol, "beta": beta,
            "totalReturn": eq.iloc[-1] / eq.iloc[0] - 1}
    for k, v in ours.items():
        js = r["js"][k]
        if js is None or not math.isfinite(js):
            if math.isfinite(v):
                print(f"MISMATCH {r['symbol']} {r['strategy']} {k}: js={js} py={v}")
                bad += 1
            continue
        if abs(js - v) > TOL * max(1, abs(v)):
            print(f"MISMATCH {r['symbol']} {r['strategy']} {k}: js={js:.10f} py={v:.10f}")
            bad += 1

print(f"Checked {len(rows)} equity curves x 7 metrics: {bad} mismatches.")
sys.exit(1 if bad else 0)
