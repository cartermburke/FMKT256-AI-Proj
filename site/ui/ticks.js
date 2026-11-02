// Date-axis ticks for charts whose x is months (turns of `turnDays` trading days) from the start.

/**
 * Ticks at real month starts (each month's first trading day), every `incr` months on calendar
 * boundaries (every 2, 3 or 6 months from January; every 12 or 24 on Januaries), as x values.
 * Ticks at whole turns would repeat or skip months, because 21 trading days drift from calendar
 * months.
 */
export function monthTicks(dates, startIdx, min, max, incr, turnDays) {
  const step = Math.max(1, Math.round(incr));
  const out = [];
  const lo = Math.max(1, Math.ceil(startIdx + min * turnDays - 1e-9));
  const hi = Math.min(dates.length - 1, Math.floor(startIdx + max * turnDays + 1e-9));
  for (let d = lo; d <= hi; d++) {
    if (dates[d].slice(5, 7) === dates[d - 1].slice(5, 7)) continue;
    const mi = Number(dates[d].slice(5, 7)) - 1;
    const yr = Number(dates[d].slice(0, 4));
    if (step >= 12 ? mi === 0 && yr % (step / 12) === 0 : mi % step === 0) out.push((d - startIdx) / turnDays);
  }
  return out;
}
