#!/usr/bin/env python3
"""Tests for scripts/fetch_data.py with the data providers replaced by stubs.

Each case runs the real main() on a copy of the committed config and data, so it checks what
the daily job would publish when a provider fails, lags or answers with differently adjusted
prices.   python3 tests/fetch_data_test.py
"""
from __future__ import annotations

import atexit
import datetime as dt
import importlib.util
import json
import shutil
import tempfile
import types
import unittest
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
FILE = {"^VIX": "VIX", "^IRX": "IRX"}


def _clean_snapshot() -> Path:
    """The committed data as a clean nightly run leaves it, with a config listing exactly its series.

    The daily job commits site/data without running CI, so CI may meet the data in any state the
    fetcher can publish (a series kept stale after a failure, a fallback source, series ahead of
    as_of), and a ticker pushed to config/tickers.json has no data until the job runs. Each case
    below builds its own provider trouble, so all of them start from a snapshot with none: every
    series cut to the last day all of them have, from yfinance.
    """
    root = Path(tempfile.mkdtemp(prefix="fetch_data_test_"))
    atexit.register(shutil.rmtree, root, True)
    meta = json.loads((REPO / "site" / "data" / "meta.json").read_text())
    have = {f for f in meta["series"] if (REPO / "site" / "data" / "prices" / f"{f}.json").exists()}
    cfg = json.loads((REPO / "config" / "tickers.json").read_text())
    cfg["pool"] = [dict(t) for t in meta["pool_info"] if t["symbol"].replace("^", "") in have]
    cfg["benchmark"] = meta.get("benchmark")
    cfg["aux"] = [a for a in cfg.get("aux", []) if a["file"] in have]
    cfg["history_years"] = int(cfg.get("history_years", 7)) + 1  # nothing is trimmed (see run_main)
    (root / "config").mkdir()
    (root / "config" / "tickers.json").write_text(json.dumps(cfg, indent=2))
    names = {t["symbol"].replace("^", ""): t.get("name", t["symbol"]) for t in cfg["pool"]}
    if cfg.get("benchmark") and cfg["benchmark"] not in {t["symbol"] for t in cfg["pool"]}:
        names[cfg["benchmark"]] = cfg["benchmark"]
    names.update({a["file"]: a.get("name", a["symbol"]) for a in cfg["aux"]})
    prices = root / "site" / "data" / "prices"
    prices.mkdir(parents=True)
    docs = {f: json.loads((REPO / "site" / "data" / "prices" / f"{f}.json").read_text()) for f in names}
    cut = min(d["dates"][-1] for d in docs.values())
    series = {}
    for f, d in docs.items():
        n = sum(x <= cut for x in d["dates"])
        d.update(name=names[f], source="yfinance", adjusted=d["kind"] == "price",
                 dates=d["dates"][:n], close=d["close"][:n])
        (prices / f"{f}.json").write_text(json.dumps(d, separators=(",", ":")))
        series[f] = {"symbol": d["symbol"], "source": "yfinance", "rows": n, "first": d["dates"][0], "last": d["dates"][-1]}
    meta.update(as_of=cut, stale=False, failures={}, series=series, pool=[t["symbol"] for t in cfg["pool"]],
                pool_info=[{"symbol": t["symbol"], "name": t.get("name", t["symbol"]), "regime": t.get("regime", "")}
                           for t in cfg["pool"]])
    (root / "site" / "data" / "meta.json").write_text(json.dumps(meta, indent=2))
    return root


SNAP = _clean_snapshot()
# "Today's" new close in these tests: the weekday after the snapshot's last day.
NEXT = (pd.Timestamp(json.loads((SNAP / "site" / "data" / "meta.json").read_text())["as_of"])
        + pd.offsets.BDay(1)).strftime("%Y-%m-%d")


class _Today(dt.date):
    """The fetcher's clock in these tests: "today" is NEXT, whatever day the tests run."""

    @classmethod
    def today(cls):
        return cls.fromisoformat(NEXT)


def committed(symbol: str) -> pd.Series:
    d = json.loads((SNAP / "site" / "data" / "prices" / f"{FILE.get(symbol, symbol)}.json").read_text())
    return pd.Series(d["close"], index=pd.to_datetime(d["dates"]), dtype="float64")


def plus_day(s: pd.Series, factor: float = 1.01) -> pd.Series:
    return pd.concat([s, pd.Series([s.iloc[-1] * factor], index=pd.to_datetime([NEXT]))])


def down(symbol, start):
    raise RuntimeError("provider down")


class FetchDataTest(unittest.TestCase):
    def run_main(self, sources, prepare=None):
        """Run main() in a fresh copy of the clean snapshot; return (exit code, meta, data dir).

        The clock is pinned to NEXT and the snapshot's history window is a year wider than the
        data, so the stubbed providers' answers are never trimmed and the results don't depend on
        the day CI runs. prepare(data_dir), if given, edits the copied data first.
        """
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / "scripts").mkdir()
        shutil.copy(REPO / "scripts" / "fetch_data.py", tmp / "scripts" / "fetch_data.py")
        shutil.copytree(SNAP / "config", tmp / "config")
        shutil.copytree(SNAP / "site" / "data", tmp / "site" / "data")
        data = tmp / "site" / "data"
        if prepare:
            prepare(data)
        spec = importlib.util.spec_from_file_location("fetch_data_under_test", tmp / "scripts" / "fetch_data.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.SOURCES[:] = sources
        mod.log = lambda msg: None
        mod.last_complete_session = lambda: dt.date.fromisoformat(NEXT)
        mod.dt = types.SimpleNamespace(date=_Today, datetime=dt.datetime, timedelta=dt.timedelta,
                                       timezone=dt.timezone, time=dt.time)
        rc = mod.main()
        return rc, json.loads((data / "meta.json").read_text()), data

    @staticmethod
    def series(data: Path, fname: str) -> pd.Series:
        d = json.loads((data / "prices" / f"{fname}.json").read_text())
        return pd.Series(d["close"], index=pd.to_datetime(d["dates"]), dtype="float64")

    def setUp(self):
        self.published = json.loads((SNAP / "site" / "data" / "meta.json").read_text())

    def test_new_close_is_appended(self):
        rc, meta, data = self.run_main([("yfinance", lambda sym, start: plus_day(committed(sym)))])
        self.assertEqual(rc, 0)
        self.assertEqual(meta["as_of"], NEXT)
        self.assertFalse(meta["stale"])
        self.assertEqual(self.series(data, "KO").index[-1], pd.Timestamp(NEXT))

    def test_series_never_moves_back(self):
        # Yahoo fails for the T-bill yield and FRED is a day behind the published data.
        def yf(sym, start):
            if sym == "^IRX":
                raise RuntimeError("down")
            return committed(sym)

        def fred(sym, start):
            if sym != "^IRX":
                raise RuntimeError("FRED only for ^IRX")
            s = committed(sym)
            return s.iloc[:-1]

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down), ("nasdaq", down), ("fred-dtb3", fred)])
        self.assertEqual(rc, 0)
        self.assertEqual(meta["as_of"], self.published["as_of"])
        self.assertIn("^IRX", meta["failures"])
        pd.testing.assert_series_equal(self.series(data, "IRX"), committed("^IRX"), check_names=False, check_freq=False)

    def test_short_answer_keeps_the_published_series(self):
        # The usual provider answers for KO without its last published day: keep the file, flag it.
        def yf(sym, start):
            s = committed(sym)
            return s.iloc[:-1] if sym == "KO" else s

        rc, meta, data = self.run_main([("yfinance", yf)])
        self.assertEqual(rc, 0)
        self.assertIn("KO", meta["failures"])
        self.assertTrue(meta["series"]["KO"].get("stale"))
        self.assertEqual(meta["as_of"], self.published["as_of"])
        pd.testing.assert_series_equal(self.series(data, "KO"), committed("KO"), check_names=False, check_freq=False)

    def test_as_of_waits_for_every_stock(self):
        # Every series gets a new close except KO, which comes back a day short without an error.
        rc, meta, data = self.run_main([("yfinance", lambda sym, start: committed(sym) if sym == "KO" else plus_day(committed(sym)))])
        self.assertEqual(rc, 0)
        self.assertEqual(meta["as_of"], self.published["as_of"])

    def test_fallback_provider_only_appends_new_days(self):
        # Both Yahoo sources are down for KO; Nasdaq answers with closes on a different basis
        # (no dividend adjustment) plus today's close.
        nasdaq_ko = plus_day(committed("KO") * 1.08, 1.02)

        def yf(sym, start):
            if sym == "KO":
                raise RuntimeError("down")
            return plus_day(committed(sym))

        def nasdaq(sym, start):
            return nasdaq_ko if sym == "KO" else plus_day(committed(sym))

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down), ("nasdaq", nasdaq)])
        self.assertEqual(rc, 0)
        ko = self.series(data, "KO")
        old = committed("KO")
        pd.testing.assert_series_equal(ko.iloc[:-1], old, check_names=False, check_freq=False)
        self.assertAlmostEqual(ko.iloc[-1] / old.iloc[-1], 1.02, places=4)
        self.assertEqual(meta["series"]["KO"]["source"], "yfinance + nasdaq")
        self.assertTrue(json.loads((data / "prices" / "KO.json").read_text())["adjusted"])
        self.assertEqual(meta["as_of"], NEXT)
        self.assertFalse(meta["stale"])

    def test_join_skips_a_day_the_fallback_lacks(self):
        # Yahoo is down for KO and Nasdaq has no bar on KO's last published day (as with Yahoo's
        # VIX holiday bars): the new close is joined on the last day both have.
        old = committed("KO")
        nasdaq_ko = plus_day(committed("KO").drop(old.index[-1]) * 1.08, 1.02)

        def yf(sym, start):
            if sym == "KO":
                raise RuntimeError("down")
            return plus_day(committed(sym))

        def nasdaq(sym, start):
            return nasdaq_ko if sym == "KO" else plus_day(committed(sym))

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down), ("nasdaq", nasdaq)])
        self.assertEqual(rc, 0)
        ko = self.series(data, "KO")
        pd.testing.assert_series_equal(ko.iloc[:-1], old, check_names=False, check_freq=False)
        self.assertAlmostEqual(ko.iloc[-1] / old.iloc[-2], 1.02, places=4)
        self.assertEqual(meta["as_of"], NEXT)
        self.assertFalse(meta["failures"])

    def test_yahoo_replaces_a_fallback_history(self):
        # KO was published from Nasdaq (unadjusted) on a night Yahoo was down. Once Yahoo answers,
        # the adjusted history replaces it instead of being appended to the unadjusted one.
        def published_from_nasdaq(data):
            f = data / "prices" / "KO.json"
            d = json.loads(f.read_text())
            d["close"] = [round(v * 1.08, 4) for v in d["close"]]
            d["source"], d["adjusted"] = "nasdaq", False
            f.write_text(json.dumps(d, separators=(",", ":")))
            m = json.loads((data / "meta.json").read_text())
            m["series"]["KO"]["source"] = "nasdaq"
            (data / "meta.json").write_text(json.dumps(m, indent=2))

        rc, meta, data = self.run_main([("yfinance", lambda sym, start: plus_day(committed(sym)))],
                                       prepare=published_from_nasdaq)
        self.assertEqual(rc, 0)
        self.assertEqual(meta["series"]["KO"]["source"], "yfinance")
        ko = json.loads((data / "prices" / "KO.json").read_text())
        self.assertTrue(ko["adjusted"])
        pd.testing.assert_series_equal(self.series(data, "KO"), plus_day(committed("KO")),
                                       check_names=False, check_freq=False)

    def test_short_fallback_answer_is_a_failure(self):
        # Yahoo is down for KO and Nasdaq answers without KO's last published day: KO keeps its
        # file and is reported, as a short Yahoo answer would be.
        def yf(sym, start):
            if sym == "KO":
                raise RuntimeError("down")
            return plus_day(committed(sym))

        def nasdaq(sym, start):
            return committed("KO").iloc[:-1] * 1.08 if sym == "KO" else plus_day(committed(sym))

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down), ("nasdaq", nasdaq)])
        self.assertEqual(rc, 0)
        self.assertIn("KO", meta["failures"])
        self.assertTrue(meta["series"]["KO"].get("stale"))
        self.assertTrue(meta["stale"])
        self.assertEqual(meta["as_of"], self.published["as_of"])
        pd.testing.assert_series_equal(self.series(data, "KO"), committed("KO"), check_names=False, check_freq=False)

    def test_rejected_answer_falls_through_to_the_next_provider(self):
        # Yahoo's KO answer is a day short; Nasdaq has the new close: Nasdaq's is used.
        def yf(sym, start):
            return committed(sym).iloc[:-1] if sym == "KO" else plus_day(committed(sym))

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down),
                                        ("nasdaq", lambda sym, start: plus_day(committed(sym) * 1.08, 1.02))])
        self.assertEqual(rc, 0)
        self.assertFalse(meta["failures"])
        self.assertEqual(meta["series"]["KO"]["source"], "yfinance + nasdaq")
        self.assertEqual(meta["as_of"], NEXT)

    def test_a_stock_stuck_days_behind_is_reported(self):
        # UBER's provider answers without an error but its data stopped 3 trading days ago.
        stuck = committed("UBER").iloc[:-2]

        def cut_uber(data):
            f = data / "prices" / "UBER.json"
            d = json.loads(f.read_text())
            d["dates"], d["close"] = d["dates"][:-2], d["close"][:-2]
            f.write_text(json.dumps(d, separators=(",", ":")))
            m = json.loads((data / "meta.json").read_text())
            m["series"]["UBER"].update(rows=len(d["dates"]), last=d["dates"][-1])
            (data / "meta.json").write_text(json.dumps(m, indent=2))

        rc, meta, data = self.run_main([("yfinance", lambda sym, start: stuck if sym == "UBER" else plus_day(committed(sym)))],
                                       prepare=cut_uber)
        self.assertEqual(rc, 0)
        self.assertEqual(meta["as_of"], self.published["as_of"])
        self.assertEqual(list(meta["failures"]), ["UBER"])
        self.assertTrue(meta["stale"])

    def test_fallback_rate_is_appended_as_is(self):
        # Yahoo is down for the T-bill yield and FRED answers on a slightly different basis plus
        # today's value: rates are levels, so the new day is appended without rescaling.
        def yf(sym, start):
            if sym == "^IRX":
                raise RuntimeError("down")
            return plus_day(committed(sym))

        def fred(sym, start):
            if sym != "^IRX":
                raise RuntimeError("FRED only for ^IRX")
            return pd.concat([committed(sym) + 0.05, pd.Series([4.2], index=pd.to_datetime([NEXT]))])

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down), ("nasdaq", down), ("fred-dtb3", fred)])
        self.assertEqual(rc, 0)
        irx = self.series(data, "IRX")
        pd.testing.assert_series_equal(irx.iloc[:-1], committed("^IRX"), check_names=False, check_freq=False)
        self.assertAlmostEqual(irx.iloc[-1], 4.2, places=4)
        self.assertEqual(meta["series"]["IRX"]["source"], "yfinance + fred-dtb3")
        self.assertEqual(meta["as_of"], NEXT)

    def test_second_fallback_night_keeps_one_label(self):
        # KO was already extended from Nasdaq last night; Yahoo is still down tonight.
        def spliced_last_night(data):
            f = data / "prices" / "KO.json"
            d = json.loads(f.read_text())
            d["source"] = "yfinance + nasdaq"
            f.write_text(json.dumps(d, separators=(",", ":")))
            m = json.loads((data / "meta.json").read_text())
            m["series"]["KO"]["source"] = "yfinance + nasdaq"
            (data / "meta.json").write_text(json.dumps(m, indent=2))

        def yf(sym, start):
            if sym == "KO":
                raise RuntimeError("down")
            return plus_day(committed(sym))

        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down),
                                        ("nasdaq", lambda sym, start: plus_day(committed(sym) * 1.08, 1.02))],
                                       prepare=spliced_last_night)
        self.assertEqual(rc, 0)
        self.assertEqual(meta["series"]["KO"]["source"], "yfinance + nasdaq")
        pd.testing.assert_series_equal(self.series(data, "KO").iloc[:-1], committed("KO"), check_names=False, check_freq=False)

    def test_fallback_with_nothing_new_changes_nothing(self):
        # Yahoo is down for KO and Nasdaq has no day after the published one: nothing changes.
        def yf(sym, start):
            if sym == "KO":
                raise RuntimeError("down")
            return committed(sym)

        before = (SNAP / "site" / "data" / "meta.json").read_text()
        rc, meta, data = self.run_main([("yfinance", yf), ("yahoo-chart", down),
                                        ("nasdaq", lambda sym, start: committed(sym) * 1.08)])
        self.assertEqual(rc, 0)
        self.assertEqual((data / "meta.json").read_text(), before)
        self.assertEqual((data / "prices" / "KO.json").read_text(),
                         (SNAP / "site" / "data" / "prices" / "KO.json").read_text())

    def test_yahoo_chart_needs_adjusted_closes_for_stocks(self):
        # Yahoo's chart API without adjclose: a stock's plain close isn't dividend-adjusted, so it
        # is refused; an index's plain close is all there is, so it is used.
        spec = importlib.util.spec_from_file_location("fetch_data_chart", REPO / "scripts" / "fetch_data.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        class Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return {"chart": {"result": [{"timestamp": [1761858000], "meta": {"gmtoffset": -14400},
                                              "indicators": {"quote": [{"close": [70.5]}]}}]}}

        mod.requests = types.SimpleNamespace(get=lambda *a, **k: Resp(), utils=mod.requests.utils)
        with self.assertRaisesRegex(RuntimeError, "no adjusted closes"):
            mod.from_yahoo_chart("KO", dt.date(2025, 1, 2))
        self.assertEqual(list(mod.from_yahoo_chart("^VIX", dt.date(2025, 1, 2))), [70.5])

    def test_nothing_new_changes_nothing(self):
        before = (SNAP / "site" / "data" / "meta.json").read_text()
        rc, meta, data = self.run_main([("yfinance", lambda sym, start: committed(sym))])
        self.assertEqual(rc, 0)
        self.assertEqual((data / "meta.json").read_text(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
