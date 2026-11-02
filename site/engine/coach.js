// Rule-based post-game debrief: turns the trade log into plain-English feedback.

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const money = (x) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;

export function debrief(game, benchmarks) {
  const log = game.log;
  const res = game.results();
  const notes = [];
  if (!log.length) return notes;

  // 1. Timing: exposure in the biggest up and down months.
  const sorted = [...log].sort((a, b) => b.stockReturn - a.stockReturn);
  const k = Math.max(1, Math.min(5, Math.floor(log.length / 5)));
  const ups = sorted.slice(0, k);
  const downs = sorted.slice(-k);
  const avg = (xs) => xs.reduce((s, x) => s + x.exposure, 0) / xs.length;
  const upExp = avg(ups);
  const downExp = avg(downs);
  const allExp = avg(log);
  notes.push({
    title: "Market timing",
    text: `Across the ${k} best months for the stock you averaged ${pct(upExp)} exposure; across the ${k} worst months, ${pct(downExp)}. Your overall average was ${pct(allExp)}.`,
    tone: upExp > downExp + 0.1 ? "good" : upExp < downExp - 0.1 ? "bad" : "neutral",
    detail: upExp > downExp + 0.1
      ? "You leaned in before rallies more than before sell-offs: real timing skill or luck, but it paid."
      : upExp < downExp - 0.1
        ? "You tended to be more exposed going into the worst months than the best ones."
        : "Your exposure barely differed between good and bad months, so returns came mostly from the stock itself.",
  });

  // 2. Shorting.
  const shortMonths = log.filter((t) => t.exposure < -0.05);
  if (shortMonths.length) {
    const won = shortMonths.filter((t) => t.stockReturn < 0).length;
    notes.push({
      title: "Shorting",
      text: `You were net short in ${shortMonths.length} month${shortMonths.length > 1 ? "s" : ""}; the stock fell in ${won} of them.`,
      tone: won / shortMonths.length >= 0.5 ? "good" : "bad",
      detail: "Shorts also paid a 0.5%/yr borrow fee and lose on dividends (the price series is total-return).",
    });
  }

  // 3. Options.
  const optMonths = log.filter((t) => t.action.legs.length);
  if (optMonths.length) {
    const net = res.attr.options;
    const yrs = Math.max(1 / 12, (log.length * 21) / 252);
    notes.push({
      title: "Options",
      text: `You traded options in ${optMonths.length} of ${log.length} months. Net option P&L: ${money(net)} (${pct(net / game.rules.stake / yrs, 1)} of the starting stake per year). Bid/ask spread paid: ${money(res.attr.spread)}.`,
      tone: net >= 0 ? "good" : "bad",
      detail: net >= 0
        ? "Selling options harvests the volatility risk premium baked into the VIX-anchored prices, at the cost of capped upside or assignment risk."
        : "Bought options lose their time value when the stock doesn't move far enough; insurance has a cost.",
    });
  }

  // 4. Costs and carry.
  notes.push({
    title: "Frictions",
    text: `Stock trading costs ${money(res.attr.costs)}, borrow fees ${money(res.attr.borrow)}, net interest ${money(res.attr.interest)}.`,
    tone: "neutral",
    detail: "Interest is earned on idle cash at the 13-week T-bill rate and paid (T-bill + 1.5%) on margin debit.",
  });

  // 5. Versus benchmarks.
  if (benchmarks && benchmarks.length) {
    const best = [...benchmarks].filter((b) => Number.isFinite(b.results.sharpe))
      .sort((a, b) => b.results.sharpe - a.results.sharpe)[0];
    const bh = benchmarks.find((b) => b.key === "buyHold");
    if (best) {
      const beat = benchmarks.filter((b) => res.sharpe > b.results.sharpe).length;
      notes.push({
        title: "Versus the benchmarks",
        text: `Your Sharpe of ${fmt(res.sharpe)} beat ${beat} of ${benchmarks.length} benchmark strategies. Best benchmark: ${best.short} (Sharpe ${fmt(best.results.sharpe)}).`,
        tone: beat >= benchmarks.length / 2 ? "good" : "bad",
        detail: bh ? `Simply buying and holding returned ${pct(bh.results.totalReturn)} with a ${pct(bh.results.maxDrawdown)} max drawdown; you returned ${pct(res.totalReturn)} with ${pct(res.maxDrawdown)}.` : "",
      });
    }
  }

  // 6. Risk events.
  if (game.events.length) {
    notes.push({
      title: "Risk events",
      text: game.events.map((e) => `Month ${e.turn + 1}: ${e.text}`).join(" "),
      tone: "bad",
      detail: "Leverage and short positions are checked against a 25% maintenance margin at every daily close.",
    });
  }
  return notes;
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(2) : "n/a";
}
