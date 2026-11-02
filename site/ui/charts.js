// Thin wrappers around uPlot that read colors and fonts from the CSS tokens, resize with
// their container, and rebuild when the theme changes or the web fonts finish loading.
import uPlot from "../vendor/uPlot.esm.js";

const registry = new Set();

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A short line sample in a color and dash pattern, for legends and table keys. */
export function lineKey(color, dash, { width = 22, stroke = 2.5 } = {}) {
  const da = dash && dash.length ? ` stroke-dasharray="${dash.join(" ")}"` : "";
  return `<svg class="line-key" width="${width}" height="6" viewBox="0 0 ${width} 6" aria-hidden="true" focusable="false"><line x1="0" y1="3" x2="${width}" y2="3" style="stroke:${color}" stroke-width="${stroke}"${da}/></svg>`;
}

const numFont = (px = 12) => `${px}px ${cssVar("--font-num") || "ui-monospace, monospace"}`;

function axis(fmt, { side = 2, size } = {}) {
  // Only set keys we mean to override: an explicit `undefined` would wipe uPlot's defaults.
  const a = {
    side,
    stroke: cssVar("--axis"),
    font: numFont(11),
    grid: { stroke: cssVar("--grid"), width: 1 },
    ticks: { stroke: cssVar("--grid"), width: 1, size: 4 },
    border: { show: side === 2, stroke: cssVar("--baseline"), width: 1 },
  };
  if (fmt) a.values = (u, vals) => vals.map((v) => (v == null ? "" : fmt(v)));
  if (size) a.size = size;
  return a;
}

function colorOf(s) {
  return s.colorVar ? cssVar(s.colorVar) : s.color;
}

function seriesOpts(s) {
  const color = colorOf(s);
  const o = {
    label: s.label,
    stroke: color,
    width: s.width ?? 2,
    show: s.show ?? true,
    spanGaps: false,
    value: (u, v) => (v == null ? "–" : s.fmt ? s.fmt(v) : v.toFixed(2)),
    points: { show: false },
  };
  if (s.dash) o.dash = s.dash;
  if (s.alpha != null) o.alpha = s.alpha;
  if (s.fillAlpha) o.fill = hexA(color, s.fillAlpha);
  if (s.bars) {
    o.paths = uPlot.paths.bars({ size: [0.7, 24], radius: 0.15 });
    o.fill = color;
    o.width = 0;
    o.points = { show: false };
  }
  return o;
}

/** Ticks at whole multiples of incr between min and max. */
function multiples(min, max, incr) {
  const out = [];
  for (let v = Math.ceil(min / incr - 1e-9) * incr; v <= max + 1e-9; v += incr) out.push(Math.round(v / incr) * incr);
  return out;
}

/** 1-2-5 ticks for log axes ($50K, $100K, $200K, $500K, $1M ...). */
function logSplits(u, axisIdx, min, max) {
  const out = [];
  if (!(min > 0) || !(max > 0)) return out;
  for (let e = Math.floor(Math.log10(min)) - 1; e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out.length >= 2 ? out : [min, max];
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function lastIndex(data) {
  const xs = data[0] || [];
  for (let i = xs.length - 1; i >= 0; i--) {
    for (let s = 1; s < data.length; s++) if (data[s][i] != null) return i;
  }
  return xs.length ? xs.length - 1 : null;
}

/** Labels at the right end of each visible line, nudged apart so they never overlap. */
function drawEndLabels(u, spec) {
  const ctx = u.ctx;
  const pr = devicePixelRatio || 1;
  const labels = [];
  spec.series.forEach((s, i) => {
    const si = i + 1;
    if (!u.series[si].show || !s.endLabel) return;
    const ys = u.data[si];
    let k = ys.length - 1;
    while (k >= 0 && ys[k] == null) k--;
    if (k < 0) return;
    const y = u.valToPos(ys[k], "y", true);
    if (!Number.isFinite(y)) return;
    labels.push({ text: s.endLabel, y, color: colorOf(s), strong: !!s.strong });
  });
  labels.sort((a, b) => a.y - b.y);
  // Labels that would overlap form a group, centered on the average end point of its lines and
  // kept inside the plot; groups merge until none overlap.
  const gap = 14 * pr;
  const top = u.bbox.top + 6 * pr;
  const bottom = u.bbox.top + u.bbox.height - 6 * pr;
  const startOf = (g) => {
    const span = (g.items.length - 1) * gap;
    const mean = g.items.reduce((s, l) => s + l.target, 0) / g.items.length;
    return Math.max(top, Math.min(bottom - span, mean - span / 2));
  };
  const groups = [];
  for (const l of labels) {
    l.target = l.y;
    groups.push({ items: [l] });
    while (groups.length > 1) {
      const g = groups[groups.length - 1];
      const p = groups[groups.length - 2];
      if (startOf(p) + p.items.length * gap <= startOf(g)) break;
      p.items.push(...g.items);
      groups.pop();
    }
  }
  for (const g of groups) {
    const s0 = startOf(g);
    g.items.forEach((l, i) => { l.y = s0 + i * gap; });
  }
  const right = u.bbox.left + u.bbox.width;
  const x = right + 7 * pr;
  ctx.save();
  // A short leader from the line's end to its label whenever the label had to move.
  ctx.lineWidth = 1 * pr;
  for (const l of labels) {
    if (Math.abs(l.y - l.target) <= 2 * pr) continue;
    ctx.strokeStyle = l.color;
    ctx.beginPath();
    ctx.moveTo(right + 1 * pr, l.target);
    ctx.lineTo(right + 5 * pr, l.y);
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const l of labels) {
    ctx.font = `${l.strong ? 600 : 400} ${11 * pr}px ${cssVar("--font") || "system-ui"}`;
    ctx.fillStyle = l.strong ? l.color : cssVar("--ink-2");
    // Long names (a challenger can type 20 characters) end in an ellipsis instead of running
    // off the canvas; the legend keeps the full name.
    const room = ctx.canvas.width - 2 * pr - x;
    let t = l.text;
    if (ctx.measureText(t).width > room) {
      while (t.length > 1 && ctx.measureText(t.trimEnd() + "…").width > room) t = t.slice(0, -1);
      t = t.trimEnd() + "…";
    }
    ctx.fillText(t, x, l.y);
  }
  ctx.restore();
}

/** Is the box (canvas pixels) clear of the trade markers and of every visible line? */
function clearOf(u, spec, x0, x1, y0, y1) {
  const pr = devicePixelRatio || 1;
  const r = 5 * pr;
  for (const m of spec.marks || []) {
    const x = u.valToPos(m.x, "x", true);
    const y = u.valToPos(m.y, "y", true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const my0 = m.up ? y + r * 2.2 : y - r * 3.9;
    const my1 = m.up ? y + r * 3.9 : y - r * 2.2;
    if (x + r + pr > x0 && x - r - pr < x1 && my1 + pr > y0 && my0 - pr < y1) return false;
  }
  const xs = u.data[0];
  for (let si = 1; si < u.series.length; si++) {
    if (!u.series[si].show) continue;
    const ys = u.data[si];
    for (let i = 0; i < xs.length; i++) {
      if (ys[i] == null) continue;
      const px = u.valToPos(xs[i], "x", true);
      if (px < x0 - pr || px > x1 + pr) continue;
      const py = u.valToPos(ys[i], "y", true);
      if (py > y0 - pr && py < y1 + pr) return false;
    }
  }
  return true;
}

/** Triangles on the price line where the player traded, plus an optional "Start" rule. */
function drawMarks(u, spec) {
  const ctx = u.ctx;
  const pr = devicePixelRatio || 1;
  ctx.save();
  ctx.textAlign = "left";
  for (const v of spec.vlines || []) {
    const x = u.valToPos(v.x, "x", true);
    if (!Number.isFinite(x) || x < u.bbox.left - 1 || x > u.bbox.left + u.bbox.width + 1) continue;
    ctx.strokeStyle = cssVar("--line-strong");
    ctx.lineWidth = 1 * pr;
    ctx.setLineDash([3 * pr, 3 * pr]);
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `${11 * pr}px ${cssVar("--font") || "system-ui"}`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(v.label).width;
    // Label to the right of the rule, or to its left when it would run off the plot; at the top of
    // the plot, or at the bottom when a trade marker or a line is in the way (its backing would
    // hide the line, and a marker would cover the word).
    const h = 15 * pr;
    const right = u.bbox.left + u.bbox.width;
    const sides = x + 4 * pr + tw > right ? [x - 4 * pr - tw] : [x + 4 * pr, x - 4 * pr - tw].filter((lx) => lx >= u.bbox.left);
    const spots = [u.bbox.top, u.bbox.top + u.bbox.height - h].flatMap((ly) => sides.map((lx) => [lx, ly]));
    const [lx, ly] = spots.find(([sx, sy]) => clearOf(u, spec, sx - 2 * pr, sx + tw + 2 * pr, sy, sy + h)) || spots[0];
    ctx.fillStyle = cssVar("--surface");
    ctx.fillRect(lx - 2 * pr, ly, tw + 4 * pr, h);
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(v.label, lx, ly + 2 * pr);
  }
  for (const m of spec.marks || []) {
    const x = u.valToPos(m.x, "x", true);
    const y = u.valToPos(m.y, "y", true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const r = 5 * pr;
    ctx.fillStyle = cssVar(m.up ? "--long" : "--short");
    ctx.strokeStyle = cssVar("--surface");
    ctx.lineWidth = 2 * pr;
    ctx.beginPath();
    if (m.up) { ctx.moveTo(x, y + r * 2.2); ctx.lineTo(x - r, y + r * 3.9); ctx.lineTo(x + r, y + r * 3.9); }
    else { ctx.moveTo(x, y - r * 2.2); ctx.lineTo(x - r, y - r * 3.9); ctx.lineTo(x + r, y - r * 3.9); }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Create a chart.
 * spec = { el, height (number | () => number), xTime, xFmt, yFmt, yLog, xIncrs, xRange, yRange, ySize,
 *          series: [{label, colorVar, width, dash, alpha, fillAlpha, fmt, bars, show, endLabel, strong}],
 *          data: [xs, ys...], zeroLine, xLabel, xLabelFmt, marks: [{x,y,up}], vlines: [{x,label}],
 *          rightPad: px reserved for end labels, xSpace: min px between x ticks, xSplits,
 *          legendToggle: legend names can be switched with the keyboard too }
 */
export function makeChart(spec) {
  const chart = { spec, u: null };
  const heightOf = () => (typeof spec.height === "function" ? spec.height() : spec.height ?? 280);
  const build = () => {
    if (chart.u) chart.u.destroy();
    const el = spec.el;
    el.innerHTML = "";
    const width = Math.max(240, el.clientWidth || 600);
    const opts = {
      width,
      height: heightOf(),
      padding: [10, spec.rightPad ?? 22, 0, 4],
      scales: {
        x: spec.xRange ? { time: !!spec.xTime, range: () => spec.xRange() } : { time: !!spec.xTime },
        y: {
          distr: spec.yLog ? 3 : 1,
          range: spec.yRange ?? ((u, min, max) => {
            if (min == null || max == null) return [0, 1];
            if (Math.abs(max - min) < 1e-9 * Math.max(1, Math.abs(max))) {
              const c = min || 1;
              return [c - Math.abs(c) * 0.05, c + Math.abs(c) * 0.05];
            }
            const pad = (max - min) * 0.06;
            return spec.yLog ? [min / 1.05, max * 1.05] : [min - pad, max + pad];
          }),
        },
      },
      axes: [
        {
          ...axis(spec.xFmt ? (v) => spec.xFmt(v) : null, { side: 2, size: spec.xTime ? 48 : 30 }), space: spec.xSpace ?? 50, ...(spec.xIncrs ? { incrs: spec.xIncrs } : {}),
          // xSplits(min, max, incr) places ticks itself (null: whole multiples of incr).
          ...(spec.xSplits ? { splits: (u, ai, min, max, incr) => spec.xSplits(min, max, incr) ?? multiples(min, max, incr) } : {}),
        },
        { ...axis(spec.yFmt ?? null, { side: 3, size: spec.ySize ?? 56 }), ...(spec.yLog ? { splits: logSplits } : {}) },
      ],
      legend: { live: true, markers: { width: 0 } },
      cursor: {
        drag: { x: false, y: false },
        points: { size: 8, width: 2, stroke: cssVar("--surface") },
      },
      series: [
        { label: spec.xLabel ?? "", value: (u, v) => (v == null ? "–" : spec.xLabelFmt ? spec.xLabelFmt(v) : String(v)) },
        ...spec.series.map(seriesOpts),
      ],
      hooks: {
        // Show the latest values in the legend whenever the pointer isn't on the chart.
        ready: [(u) => { const i = lastIndex(u.data); if (i != null) u.setLegend({ idx: i }); }],
        setCursor: [(u) => {
          if (u.cursor.idx == null) { const i = lastIndex(u.data); if (i != null) u.setLegend({ idx: i }); }
        }],
        setData: [(u) => { const i = lastIndex(u.data); if (i != null && u.cursor.idx == null) u.setLegend({ idx: i }); }],
        draw: [],
      },
    };
    if (spec.zeroLine) {
      opts.hooks.draw.push((u) => {
        const y = u.valToPos(0, "y", true);
        if (!Number.isFinite(y)) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = cssVar("--baseline");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      });
    }
    if (spec.marks || spec.vlines) opts.hooks.draw.push((u) => drawMarks(u, spec));
    if (spec.series.some((s) => s.endLabel)) opts.hooks.draw.push((u) => drawEndLabels(u, spec));
    chart.u = new uPlot(opts, spec.data, el);
    // Legend keys are short line samples in the series color and dash (identity never by text color).
    el.querySelectorAll(".u-legend .u-series").forEach((row, i) => {
      if (i === 0) return;
      const s = spec.series[i - 1];
      const m = row.querySelector(".u-marker");
      if (m && s) {
        m.className = "u-marker key-svg";
        m.removeAttribute("style");
        m.innerHTML = s.bars
          ? `<svg class="line-key" width="12" height="10" aria-hidden="true"><rect width="12" height="10" rx="2" style="fill:${colorOf(s)}"/></svg>`
          : lineKey(colorOf(s), s.dash, { stroke: Math.min(3, s.width ?? 2) });
      }
      // A name in the legend hides or shows its line on click (uPlot's handler is on the name
      // cell); make that cell a toggle button for the keyboard and screen readers too.
      const name = row.querySelector("th");
      if (spec.legendToggle && name && s) {
        name.tabIndex = 0;
        name.setAttribute("role", "button");
        name.setAttribute("aria-label", `Show the ${s.label} line`);
        const sync = () => name.setAttribute("aria-pressed", String(!row.classList.contains("u-off")));
        sync();
        name.addEventListener("click", sync); // runs after uPlot's own handler has toggled the line
        name.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          name.click();
        });
      }
    });
  };
  chart.update = (data, extra = {}) => {
    spec.data = data;
    Object.assign(spec, extra);
    if (chart.u) chart.u.setData(data);
    else build();
  };
  chart.redraw = () => chart.u && chart.u.redraw();
  chart.rebuild = build;
  chart.destroy = () => {
    if (chart.u) chart.u.destroy();
    chart.ro?.disconnect();
    registry.delete(chart);
  };
  build();
  chart.ro = new ResizeObserver(() => {
    if (!chart.u) return;
    const w = Math.max(240, spec.el.clientWidth);
    const h = heightOf();
    if (Math.abs(w - chart.u.width) > 2 || h !== chart.u.height) chart.u.setSize({ width: w, height: h });
  });
  chart.ro.observe(spec.el);
  registry.add(chart);
  return chart;
}

export function rebuildAll() {
  for (const c of registry) c.rebuild();
}

// Axes and labels are drawn on canvas with the web fonts, so redraw once they're ready.
if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => rebuildAll()).catch(() => {});
}
