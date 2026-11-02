export const money = (x, opts = {}) => {
  if (!Number.isFinite(x)) return "–";
  const abs = Math.abs(x);
  const trim = (t) => t.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  const s = opts.compact && abs >= 1e6 ? `$${trim((abs / 1e6).toFixed(2))}M`
    : opts.compact && abs >= 1e4 ? `$${trim((abs / 1e3).toFixed(1))}K`
      : `$${Math.round(abs).toLocaleString("en-US")}`;
  return (x < 0 ? "−" : "") + s;
};

export const pct = (x, d = 1, signed = false) => {
  if (!Number.isFinite(x)) return "–";
  const v = (x * 100).toFixed(d);
  const sign = signed && x > 0 ? "+" : "";
  return `${sign}${v.replace("-", "−")}%`;
};

export const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d).replace("-", "−") : "–");

export const signClass = (x) => (x > 1e-9 ? "up" : x < -1e-9 ? "down" : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
export const fmtMonthYear = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
export const isoToSec = (iso) => Date.parse(iso + "T00:00:00Z") / 1000;
