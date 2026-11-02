export const money = (x, opts = {}) => {
  if (!Number.isFinite(x)) return "–";
  const abs = Math.abs(x);
  const trim = (t) => t.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  const s = opts.compact && abs >= 1e6 ? `$${trim((abs / 1e6).toFixed(2))}M`
    : opts.compact && abs >= 1e4 ? `$${trim((abs / 1e3).toFixed(1))}K`
      : `$${Math.round(abs).toLocaleString("en-US")}`;
  // Values that round to zero dollars print as "$0", never "−$0".
  return (x < 0 && Math.round(abs) > 0 ? "−" : "") + s;
};

/**
 * A change with its direction spelled out three ways (sign, arrow, class), so gain and
 * loss never rely on color alone. Returns { text, cls } where cls is "gain", "loss" or "flat".
 */
export const change = (x, fmt = (v) => pct(v, 1, true)) => {
  if (!Number.isFinite(x)) return { text: "–", cls: "flat" };
  const dir = x > 1e-9 ? "gain" : x < -1e-9 ? "loss" : "flat";
  const arrow = dir === "gain" ? "▲ " : dir === "loss" ? "▼ " : "";
  return { text: `${arrow}${fmt(x)}`, cls: dir };
};

export const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${s}`;
};

export const pct = (x, d = 1, signed = false) => {
  if (!Number.isFinite(x)) return "–";
  const v = (x * 100).toFixed(d);
  const sign = signed && x > 0 ? "+" : "";
  return `${sign}${v.replace("-", "−")}%`;
};

export const num = (x, d = 2) => {
  if (!Number.isFinite(x)) return "–";
  const t = x.toFixed(d);
  return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t.replace("-", "−");
};

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
