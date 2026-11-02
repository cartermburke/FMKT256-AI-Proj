#!/usr/bin/env python3
"""Builds the class submission PDF: submission/FMKT256_AI_Project.pdf

Inputs (all regenerated from the repo, nothing typed in by hand except team.json/ai_log.json):
  submission/team.json          title, team names, links
  submission/ai_log.json        how AI was used + review findings fixed
  submission/demo.json          demo replay (node submission/make_demo.mjs UBER)
  submission/img/*.png          screenshots (node submission/screenshots.mjs)
  tests/artifacts/curves.json   benchmark results on every stock (node tests/export_curves.mjs)
Test counts are taken from actually running the test suites.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle)

ROOT = Path(__file__).resolve().parents[1]
SUB = ROOT / "submission"
OUT = SUB / "FMKT256_AI_Project.pdf"

pdfmetrics.registerFont(TTFont("Sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Sans-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Mono", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"))
pdfmetrics.registerFontFamily("Sans", normal="Sans", bold="Sans-Bold", italic="Sans", boldItalic="Sans-Bold")

INK = colors.HexColor("#0b0b0b")
INK2 = colors.HexColor("#52514e")
MUTED = colors.HexColor("#6f6d68")
ACCENT = colors.HexColor("#2a78d6")
ACCENT_INK = colors.HexColor("#1c5cab")
WASH = colors.HexColor("#eaf2fc")
GRID = colors.HexColor("#e1e0d9")
SURF = colors.HexColor("#f6f5f2")

ss = {
    "title": ParagraphStyle("title", fontName="Sans-Bold", fontSize=30, leading=34, textColor=INK, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName="Sans", fontSize=13.5, leading=18, textColor=INK2, spaceAfter=10),
    "meta": ParagraphStyle("meta", fontName="Sans", fontSize=9.5, leading=13, textColor=MUTED),
    "h1": ParagraphStyle("h1", fontName="Sans-Bold", fontSize=16, leading=20, textColor=INK, spaceBefore=4, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName="Sans-Bold", fontSize=11.5, leading=15, textColor=INK, spaceBefore=8, spaceAfter=3),
    "body": ParagraphStyle("body", fontName="Sans", fontSize=9.6, leading=13.6, textColor=INK2, alignment=TA_LEFT, spaceAfter=5),
    "bullet": ParagraphStyle("bullet", fontName="Sans", fontSize=9.6, leading=13.4, textColor=INK2, leftIndent=12,
                             bulletIndent=2, spaceAfter=2.5),
    "small": ParagraphStyle("small", fontName="Sans", fontSize=8.2, leading=11, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Sans", fontSize=8.6, leading=11, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Sans-Bold", fontSize=8.6, leading=11, textColor=INK),
    "formula": ParagraphStyle("formula", fontName="Sans", fontSize=11, leading=15, textColor=INK, alignment=1,
                              backColor=SURF, borderPadding=7, spaceBefore=4, spaceAfter=8),
    "link": ParagraphStyle("link", fontName="Sans", fontSize=9.4, leading=12.5, textColor=ACCENT_INK),
}


def P(text, style="body"):
    return Paragraph(text, ss[style])


def bullets(items):
    return [Paragraph(t, ss["bullet"], bulletText="•") for t in items]


def link(url, label=None):
    return f'<link href="{url}" color="#1c5cab"><u>{label or url}</u></link>'


def img(path: Path, width: float, max_h: float | None = None, crop_h_frac: float | None = None):
    ir = ImageReader(str(path))
    w, h = ir.getSize()
    if crop_h_frac:
        from PIL import Image as PILImage
        im = PILImage.open(path)
        im = im.crop((0, 0, w, int(h * crop_h_frac)))
        tmp = path.with_name(path.stem + "_crop.png")
        im.save(tmp)
        path, h = tmp, int(h * crop_h_frac)
    height = width * h / w
    if max_h and height > max_h:
        width, height = max_h * w / h, max_h
    im = Image(str(path), width=width, height=height)
    im.hAlign = "CENTER"
    return im


def framed(flowable, pad=4):
    t = Table([[flowable]], colWidths=[flowable.drawWidth + 2 * pad])
    t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, GRID), ("LEFTPADDING", (0, 0), (-1, -1), pad),
                           ("RIGHTPADDING", (0, 0), (-1, -1), pad), ("TOPPADDING", (0, 0), (-1, -1), pad),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), pad)]))
    return t


def run(cmd: str) -> str:
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=600)
    return r.stdout + r.stderr


# ----------------------------------------------------------------------------- data

team = json.loads((SUB / "team.json").read_text())
ai = json.loads((SUB / "ai_log.json").read_text())
demo = json.loads((SUB / "demo.json").read_text())
meta = json.loads((ROOT / "site" / "data" / "meta.json").read_text())

unit_out = run("node --test tests/*.test.mjs")
unit_pass = int(re.search(r"# pass (\d+)", unit_out).group(1))
unit_fail = int(re.search(r"# fail (\d+)", unit_out).group(1))
run("node tests/export_curves.mjs")
xcheck_out = run("python3 tests/check_metrics.py")
m = re.search(r"Checked (\d+) equity curves x (\d+) metrics: (\d+) mismatches", xcheck_out)
xc_curves, xc_metrics, xc_bad = (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, -1)
e2e = json.loads((ROOT / "tests" / "artifacts" / "e2e_summary.json").read_text())
curves = json.loads((ROOT / "tests" / "artifacts" / "curves.json").read_text())

by = {}
for r in curves:
    by.setdefault(r["symbol"], {})[r["strategy"]] = r["js"]
info = {p["symbol"]: p for p in meta.get("pool_info", [])}

as_of = meta["as_of"]
months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
y, mo, d = map(int, as_of.split("-"))
as_of_txt = f"{months[mo - 1]} {d}, {y}"
n_stocks = len(meta["pool"])

# ----------------------------------------------------------------------------- page decorations


def on_page(c, doc):
    c.saveState()
    c.setFont("Sans", 7.8)
    c.setFillColor(MUTED)
    c.drawString(0.7 * inch, 0.45 * inch, f"{team['title']} · {team['course']}")
    c.drawRightString(letter[0] - 0.7 * inch, 0.45 * inch, f"{doc.page}")
    c.setStrokeColor(GRID)
    c.line(0.7 * inch, 0.6 * inch, letter[0] - 0.7 * inch, 0.6 * inch)
    c.restoreState()


doc = SimpleDocTemplate(str(OUT), pagesize=letter, leftMargin=0.7 * inch, rightMargin=0.7 * inch,
                        topMargin=0.6 * inch, bottomMargin=0.8 * inch, title=f"{team['title']}: FMKT 256 AI project",
                        author=", ".join(team["team"]), subject=team["course"])
W = letter[0] - 1.4 * inch
story = []

# ----------------------------------------------------------------------------- page 1

story += [P(team["title"], "title"), P(team["subtitle"], "subtitle"),
          P(f"{team['course']}<br/>Team: {', '.join(team['team'])}", "meta"), Spacer(1, 10)]

link_rows = [
    ["Play the game (no login, desktop or phone)", link(team["site_url"])],
    ["One-click demo game (replay)", link(demo["url"], "Demo: a full 5-year blind game, scripted player")],
    ["Source code, tests and data", link(team["repo_url"])],
    ["Daily data-update job (run history)", link(team["actions_url"], "GitHub Actions: update-data")],
    ["Live data status", link(team["site_url"] + "#/data", "Data page: series, sources, last update")],
]
lt = Table([[P(a, "cellb"), Paragraph(b, ss["link"])] for a, b in link_rows], colWidths=[2.45 * inch, W - 2.45 * inch])
lt.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), WASH), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("LINEBELOW", (0, 0), (-1, -2), 0.5, colors.white), ("LEFTPADDING", (0, 0), (-1, -1), 8),
                        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
story += [lt, Spacer(1, 10)]

story += [P("What we built", "h1"),
          P(f"<b>Blind Tape</b> is a browser trading game on real market data, built with Claude. Each player starts "
            f"with a fixed <b>$100,000</b> and gets a stock drawn at random from {n_stocks} instruments. In blind mode the "
            "ticker and dates are hidden and the price is rebased to 100, so no one can trade on what they remember. "
            "The game steps through the <b>most recent five years</b> of daily prices one month at a time. Each month the "
            "player sets a long or short stock position and can trade one-month <b>calls and puts</b>. At the end the "
            "stock is revealed and the player is scored on <b>Sharpe ratio, maximum drawdown and IRR</b>, the criteria "
            "named in the prompt. The score is set against five autopilot strategies played on the same data with the "
            "same costs."),
          P("How it meets the prompt", "h2")]
story += bullets([
    "<b>Trading game:</b> fixed stake, one stock plus its derivatives over a fixed five-year period, judged on Sharpe, max drawdown and IRR (plus Sortino, volatility and beta).",
    f"<b>Imports historical data:</b> about 7 years of daily adjusted closes for {n_stocks} instruments, the VIX and the 13-week T-bill yield, downloaded by code (yfinance with fallbacks) and validated before use.",
    f"<b>Updates when new data arrive:</b> a scheduled GitHub Actions job runs every weekday after the close, appends the new bar, commits it and redeploys the site. The five-year window always ends at the latest close (currently {as_of_txt}).",
    "<b>Repeatable without coding:</b> adding a stock to the game is one line in <font name='Mono'>config/tickers.json</font>; the next run downloads its history automatically.",
    "<b>No logins:</b> the game, the code and the data history are all public pages.",
])
story += [Spacer(1, 2), framed(img(SUB / "img" / "reveal.png", W - 8, max_h=1.45 * inch))]
story.append(PageBreak())

# ----------------------------------------------------------------------------- page 2

story += [P("Playing a month", "h1"),
          P("The left side shows the price history (up to a year before the start, plus every month played so far) "
            "with the 200-day average, and the account's daily marked-to-market equity next to simply holding the "
            "stock. The order ticket on the right sets the stock position and lists live option quotes at five "
            "strikes. Every order is checked before it can be submitted, and the ticket previews cash, costs and "
            "exposure."),
          framed(img(SUB / "img" / "game.png", W - 8, max_h=4.6 * inch)), Spacer(1, 8),
          P("Rules", "h2")]
story += bullets([
    "<b>Turns:</b> 21 trading days each; 60 turns for the full challenge, or a random 12-month slice in a quick round.",
    "<b>Stock:</b> −100% (short) to +150% (long on margin) of equity; 5 bp per trade.",
    "<b>Options:</b> one-month European calls and puts at 90, 95, 100, 105 and 110% strikes, cash-settled at expiry. You buy at the ask and sell at the bid.",
    "<b>Writing options:</b> written calls must be covered by shares; written puts must be cash-secured.",
    "<b>Financing:</b> cash earns the T-bill rate daily, margin debit pays T-bill + 1.5%, shorts pay 0.5% a year to borrow, and borrowing is capped at 50% of equity.",
    "<b>Risk controls:</b> margin is checked at every daily close. Equity below 25% of the gross stock position forces liquidation, and equity at zero ends the game.",
    "<b>Autopilot and replays:</b> an autopilot can finish the game with any benchmark rule, and every game produces a replay link that reproduces it exactly.",
])
story.append(PageBreak())

# ----------------------------------------------------------------------------- page 3

you, bh = demo["you"], demo["buyHold"]
story += [P("The scorecard and the debrief", "h1"),
          P(f"At the end the stock is revealed. The demo game linked on page 1 is a scripted player on a blind "
            f"five-year game. Its rule: long when the price is above its 200-day average and sell calls when the VIX is "
            f"above 22; below the average, stay mostly in T-bills with put protection. "
            f"The stock turned out to be <b>{info.get(demo['symbol'], {}).get('name', demo['symbol'])} ({demo['symbol']})</b>. "
            f"The scripted player had a Sharpe ratio of <b>{you['sharpe']:.2f}</b> vs {bh['sharpe']:.2f} for buy &amp; hold, "
            f"a max drawdown of <b>{you['maxDrawdown'] * 100:.0f}%</b> vs {bh['maxDrawdown'] * 100:.0f}%, and an IRR of "
            f"<b>{you['irr'] * 100:.1f}%</b> vs {bh['irr'] * 100:.1f}%. The same rule loses to buy &amp; hold on most "
            "other stocks (next page), which is part of the lesson."),
          framed(img(SUB / "img" / "scorecard.png", W - 8, max_h=3.6 * inch)), Spacer(1, 8),
          P("Each row is ranked by Sharpe ratio. <b>Sharpe</b> is the mean daily return in excess of the T-bill rate "
            "divided by its standard deviation, × √252. <b>Max drawdown</b> is the largest peak-to-trough fall in "
            "daily equity. <b>IRR</b> is the XIRR of the account's cash flows. With a fixed stake that is the compound "
            "annual growth rate, and the engine computes a general XIRR so contributions could be added. A rule-based "
            "coach then explains the result: market timing, shorts, options P&amp;L, frictions, and the comparison with "
            "the benchmarks."),
          framed(img(SUB / "img" / "coach.png", W - 8, max_h=2.7 * inch))]
story.append(PageBreak())

# ----------------------------------------------------------------------------- page 4

story += [P("What five years of real data say about the benchmarks", "h1"),
          P(f"Every game is benchmarked against five rules. Here they are on the full five-year window for every "
            f"instrument in the pool (data through {as_of_txt}). Cells show the Sharpe ratio; the best in each row is "
            "bold. The last two columns are for buy &amp; hold.")]
hdr = ["Stock", "Regime", "Buy &amp; hold", "Covered call", "Protective put", "200-day trend", "S&amp;P 500", "B&amp;H max DD", "B&amp;H IRR"]
rows = [[P(h, "cellb") for h in hdr]]
keys = ["buyHold", "coveredCall", "protectivePut", "trend200", "spy"]
wins = {k: 0 for k in keys}
for sym in meta["pool"]:
    s = by.get(sym)
    if not s:
        continue
    sh = {k: s[k]["sharpe"] for k in keys if k in s}
    best = max(sh, key=sh.get)
    for k in ("coveredCall", "protectivePut", "trend200"):
        if sh[k] > sh["buyHold"]:
            wins[k] += 1
    row = [P(f"<b>{sym}</b>", "cell"), P(info.get(sym, {}).get("regime", ""), "cell")]
    for k in keys:
        txt = f"{sh[k]:.2f}"
        row.append(P(f"<b>{txt}</b>" if k == best else txt, "cell"))
    row += [P(f"{-s['buyHold']['maxDrawdown'] * 100:.0f}%", "cell"), P(f"{s['buyHold']['irr'] * 100:+.1f}%", "cell")]
    rows.append(row)
cw = [0.55, 1.05, 0.72, 0.78, 0.82, 0.82, 0.62, 0.7, 0.66]
scale = W / (sum(cw) * inch)
bt = Table(rows, colWidths=[c * inch * scale for c in cw], repeatRows=1)
bt.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.8, INK2), ("LINEBELOW", (0, 1), (-1, -1), 0.4, GRID),
                        ("ALIGN", (2, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
story += [bt, Spacer(1, 8), P("Takeaways", "h2")]
n = len(rows) - 1
story += bullets([
    f"<b>Covered calls</b> beat buy &amp; hold on Sharpe for {wins['coveredCall']} of {n} instruments. They win on "
    "low-volatility names and the index, where option premiums carry the most variance risk premium, and lag badly "
    "on the big trenders, whose upside they cap.",
    f"<b>Protective puts</b> improved Sharpe for {wins['protectivePut']} of {n}. Insurance helps in crashes but costs "
    "time value every month.",
    f"<b>The 200-day trend rule</b> improved Sharpe for {wins['trend200']} of {n}, usually by cutting drawdowns in long "
    "declines rather than by adding return.",
    "No single rule dominates, so a human who reads the tape well can beat all five. That is what makes the game worth "
    "playing.",
])
story.append(PageBreak())

# ----------------------------------------------------------------------------- page 5


def pipeline_drawing(width):
    dwg = Drawing(width, 118)
    boxes = [
        ("config/tickers.json", "ticker list\n(edit to add stocks)"),
        ("GitHub Actions", "every weekday\nafter the close"),
        ("fetch_data.py", "yfinance → Yahoo\n→ Nasdaq; validate"),
        ("site/data/*.json", "commit only\nif data changed"),
        ("GitHub Pages", "window ends at\nthe latest close"),
    ]
    n_ = len(boxes)
    gap = 14
    bw = (width - gap * (n_ - 1)) / n_
    for i, (t, sub) in enumerate(boxes):
        x = i * (bw + gap)
        dwg.add(Rect(x, 30, bw, 66, rx=6, ry=6, fillColor=WASH if i != 1 else colors.HexColor("#fde9df"),
                     strokeColor=ACCENT if i != 1 else colors.HexColor("#eb6834"), strokeWidth=0.8))
        dwg.add(String(x + bw / 2, 78, t, fontName="Sans-Bold", fontSize=8.2, fillColor=INK, textAnchor="middle"))
        for j, line in enumerate(sub.split("\n")):
            dwg.add(String(x + bw / 2, 62 - j * 10, line, fontName="Sans", fontSize=6.9, fillColor=INK2,
                           textAnchor="middle"))
        if i < n_ - 1:
            ax = x + bw + 2
            dwg.add(Line(ax, 63, ax + gap - 5, 63, strokeColor=INK2, strokeWidth=1))
            dwg.add(Polygon([ax + gap - 4, 63, ax + gap - 8, 66, ax + gap - 8, 60], fillColor=INK2, strokeColor=INK2))
    dwg.add(String(width / 2, 10, "If every source fails for a series, the last good data is kept and the site shows a stale-data banner.",
                   fontName="Sans", fontSize=7.4, fillColor=MUTED, textAnchor="middle"))
    return dwg


story += [P("How it works under the hood", "h1"), P("Data pipeline: historical import and daily updates", "h2"),
          pipeline_drawing(W),
          P("Pricing options without historical option quotes", "h2"),
          P("Free historical option chains for every stock don't exist, so options are priced with Black-Scholes on an "
            "implied volatility built from market data on each day:"),
          P("IV² = RV<sub>63</sub>(stock)² + [ (VIX / 100)² − RV<sub>63</sub>(S&amp;P 500)² ]", "formula"),
          P("RV<sub>63</sub> is trailing 63-day realized volatility. The bracket is the market's variance risk premium "
            "that day: what investors pay for S&amp;P 500 volatility beyond what the index is delivering. This prices "
            "SPY options exactly at the VIX and gives single stocks a modest premium over their own realized vol. "
            "<b>We changed this model during the build.</b> The first version multiplied each stock's realized vol by "
            "the index's VIX-to-realized ratio. Running the benchmarks on real data showed covered calls beating buy "
            "&amp; hold on almost every stock (TSLA +197% vs +32%), which doesn't happen in real markets, because the "
            "volatility risk premium is concentrated in index options. The additive model fixed it."),
          P("Verification", "h2")]
story += bullets([
    f"<b>{unit_pass} unit tests</b> ({unit_fail} failing) on the engine: Black-Scholes textbook values and put-call parity, "
    "the IV model, option settlement, covered and cash-secured rules, margin calls, short squeezes, interest accrual, "
    "and the Sharpe, Sortino, drawdown and XIRR math. They run on every push in GitHub Actions.",
    f"<b>Independent cross-check:</b> a separate Python/pandas script recomputed {xc_metrics} metrics on "
    f"{xc_curves} real five-year equity curves (every benchmark on every stock): <b>{xc_bad} mismatches</b> beyond 1e-6.",
    f"<b>End-to-end browser test:</b> {e2e['passed']} of {e2e['passed'] + e2e['failed']} checks pass. It plays games through the real "
    "UI in Chromium: valid and invalid orders, autopilot, the reveal, the replay link reproducing the exact result, "
    "the data page, dark mode and a phone-sized screen, with no console errors.",
    "<b>Adversarial review:</b> separate AI agents audited the finance math, tried to break the game, and played it "
    "as a first-time user. Their verified findings were fixed (next page).",
])
story.append(PageBreak())

# ----------------------------------------------------------------------------- page 6

story += [P("How we used AI", "h1")]
story += bullets(ai["process"])
if ai.get("fixes"):
    story += [P("Issues the AI review found and we fixed", "h2")]
    story += bullets(ai["fixes"])
story += [P("Limitations", "h2")]
story += bullets([
    "Option prices are model prices, not historical quotes. There is no volatility skew, so out-of-the-money puts are probably cheaper here than they were in real markets.",
    "Decisions are monthly and fill at the daily close. Fractional shares are allowed, and there is no market impact beyond the fixed costs.",
    "Prices are dividend-adjusted (total return), so options are priced as if the stock paid no dividends.",
    "In blind mode a well-known stock can sometimes be recognised from the shape of its chart.",
])
story += [Spacer(1, 8),
          P("Run it yourself", "h2"),
          P(f"Everything is in the public repository ({link(team['repo_url'])}). Open "
            "<font name='Mono'>site/index.html</font> through any static server; run "
            "<font name='Mono'>node --test tests/*.test.mjs</font> for the unit tests. To add a stock, edit "
            "<font name='Mono'>config/tickers.json</font> and push; the update job does the rest."),
          Spacer(1, 6),
          P("Academic exercise for FMKT 256, not investment advice. Results on historical data say nothing about "
            "future returns.", "small")]

doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f"wrote {OUT.relative_to(ROOT)} | unit {unit_pass}/{unit_pass + unit_fail} | xcheck {xc_curves}x{xc_metrics} bad={xc_bad} | e2e {e2e['passed']}/{e2e['passed'] + e2e['failed']}")
