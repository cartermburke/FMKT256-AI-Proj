// Rule-based post-game debrief: turns the trade log into plain-English feedback.
import { rankStrategies } from "./scoring.js";

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const money = (x) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const ord = (n) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export function debrief(game, benchmarks) {
  const log = game.log;
  const res = game.results();
  const notes = [];
  if (!log.length) return notes;
  const expOf = (t) => (Number.isFinite(t.netExposure) ? t.netExposure : t.exposure);

  // 1. Timing: net exposure (stock + option delta) in the biggest up and down months.
  const full = log.filter((t) => t.endIdx - t.startIdx >= 1);
  const sorted = [...full].sort((a, b) => b.stockReturn - a.stockReturn);
  const k = Math.max(1, Math.min(5, Math.floor(full.length / 5)));
  const ups = sorted.slice(0, k);
  const downs = sorted.slice(-k);
  const avg = (xs) => xs.reduce((s, x) => s + expOf(x), 0) / xs.length;
  const upExp = avg(ups);
  const downExp = avg(downs);
  const allExp = avg(full);
  notes.push({
    title: "Market timing",
    text: `In the stock's ${k} best month${k > 1 ? "s" : ""} your net exposure (stock plus option delta) averaged ${pct(upExp)}; in its ${k} worst, ${pct(downExp)}. Overall average: ${pct(allExp)}.`,
    tone: upExp > downExp + 0.1 ? "good" : upExp < downExp - 0.1 ? "bad" : "neutral",
    detail: upExp > downExp + 0.1
      ? "You leaned in before rallies more than before sell-offs. That could be skill or luck, but it paid."
      : upExp < downExp - 0.1
        ? "You tended to be more exposed going into the worst months than into the best ones."
        : "Your exposure barely differed between good and bad months, so your result came mostly from the stock itself.",
  });

  // 2. Shorting.
  const shortMonths = full.filter((t) => expOf(t) < -0.05);
  if (shortMonths.length) {
    const won = shortMonths.filter((t) => t.stockReturn < 0).length;
    notes.push({
      title: "Shorting",
      text: `You were net short in ${shortMonths.length} month${shortMonths.length > 1 ? "s" : ""}, and the stock fell in ${won} of them.`,
      tone: won / shortMonths.length >= 0.5 ? "good" : "bad",
      detail: "Shorts also pay a 0.5% a year borrow fee and lose the dividends, because the price series includes them.",
    });
  }

  // 3. Options: explain by what was actually traded (bought vs written) and how it went.
  const optMonths = log.filter((t) => t.action.legs.length);
  if (optMonths.length) {
    const net = res.attr.options;
    const yrs = Math.max(1 / 12, (log.length * 21) / 252);
    const bought = optMonths.reduce((s, t) => s + (t.boughtPremium || 0), 0);
    const written = optMonths.reduce((s, t) => s + (t.writtenPremium || 0), 0);
    const mostlyWriter = written > bought;
    let detail;
    if (mostlyWriter && net >= 0) detail = "You mostly sold options and kept more premium than you paid out. That is the volatility risk premium, and the cost is capped upside or being put the stock.";
    else if (mostlyWriter) detail = "You mostly sold options, but the stock moved further than the premiums priced in, so payouts exceeded the premium collected.";
    else if (net >= 0) detail = "You mostly bought options, and they paid off: the stock moved further than the implied volatility had priced.";
    else detail = "You mostly bought options. Their time value decays when the stock doesn't move far enough, so insurance and lottery tickets both have a cost.";
    notes.push({
      title: "Options",
      text: `You traded options in ${optMonths.length} of ${log.length} months: ${money(bought)} of premium bought and ${money(written)} written. Net option P&L was ${money(net)}, or ${pct(net / game.rules.stake / yrs, 1)} of the starting stake a year. Bid/ask spread paid: ${money(res.attr.spread)}.`,
      tone: net >= 0 ? "good" : "bad",
      detail,
    });
  }

  // 4. Costs and carry.
  notes.push({
    title: "Frictions",
    text: `Stock trading costs ${money(res.attr.costs)}, borrow fees ${money(res.attr.borrow)}, net interest ${money(res.attr.interest)}.`,
    tone: "neutral",
    detail: "Idle cash earns the 13-week T-bill rate; margin debit pays T-bill + 1.5%.",
  });

  // 5. Versus the benchmarks, using the same overall ranking as the scorecard.
  if (benchmarks && benchmarks.length) {
    const rows = rankStrategies([{ key: "you", short: "You", results: res }, ...benchmarks]);
    const you = rows.find((r) => r.key === "you");
    const best = rows.find((r) => r.key !== "you");
    const bh = benchmarks.find((b) => b.key === "buyHold");
    notes.push({
      title: "Versus the benchmarks",
      text: `Overall you placed ${ord(you.overall)} of ${rows.length}: ${ord(you.ranks.sharpe)} on Sharpe, ${ord(you.ranks.maxDrawdown)} on max drawdown and ${ord(you.ranks.irr)} on IRR.${best ? ` The top benchmark was ${best.short}.` : ""}`,
      tone: you.overall <= Math.ceil(rows.length / 2) ? "good" : "bad",
      detail: bh ? `Simply buying and holding returned ${pct(bh.results.totalReturn)} with a ${pct(bh.results.maxDrawdown)} max drawdown. You returned ${pct(res.totalReturn)} with ${pct(res.maxDrawdown)}.` : "",
    });
  }

  // 6. Risk events.
  if (game.events.length) {
    notes.push({
      title: "Risk events",
      text: game.events.map((e) => `Month ${e.turn + 1}: ${e.text}`).join(" "),
      tone: "bad",
      detail: "Stock positions are checked against a 25% maintenance margin at every daily close.",
    });
  }
  return notes;
}
