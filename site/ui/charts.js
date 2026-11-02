// Thin wrappers around uPlot that read colors from the CSS tokens, resize with their
// container, and rebuild when the light/dark theme changes.
import uPlot from "../vendor/uPlot.esm.js";

const registry = new Set();

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function axis(fmt, { side = 2, size } = {}) {
  // Only set keys we mean to override: an explicit `undefined` would wipe uPlot's defaults.
  const a = {
    side,
    stroke: cssVar("--axis"),
    font: `12px ${cssVar("--font") || "system-ui"}`,
    grid: { stroke: cssVar("--grid"), width: 1 },
    ticks: { stroke: cssVar("--grid"), width: 1, size: 4 },
    border: { show: side === 2, stroke: cssVar("--baseline"), width: 1 },
  };
  if (fmt) a.values = (u, vals) => vals.map((v) => (v == null ? "" : fmt(v)));
  if (size) a.size = size;
  return a;
}

function seriesOpts(s) {
  const color = s.colorVar ? cssVar(s.colorVar) : s.color;
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
  if (s.fillAlpha) o.fill = hexA(color, s.fillAlpha);
  if (s.bars) {
    o.paths = uPlot.paths.bars({ size: [0.7, 24], radius: 0.15 });
    o.fill = color;
    o.width = 0;
    o.points = { show: false };
  }
  return o;
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

/**
 * Create a chart.
 * spec = { el, height, xTime, xFmt, yFmt, yLog, series: [{label, colorVar, width, dash, fillAlpha, fmt, bars, show}],
 *          data: [xs, ys...], yRange?: [min,max] | fn, zeroLine?: bool, xLabelFmt?: fn for legend x }
 */
export function makeChart(spec) {
  const chart = { spec, u: null };
  const build = () => {
    if (chart.u) chart.u.destroy();
    const el = spec.el;
    el.innerHTML = "";
    const width = Math.max(260, el.clientWidth || 600);
    const opts = {
      width,
      height: spec.height ?? 280,
      padding: [10, 12, 0, 4],
      scales: {
        x: { time: !!spec.xTime },
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
        { ...axis(spec.xFmt ? (v) => spec.xFmt(v) : null, { side: 2 }), ...(spec.xIncrs ? { incrs: spec.xIncrs } : {}) },
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
      hooks: {},
    };
    if (spec.zeroLine) {
      opts.hooks.draw = [(u) => {
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
      }];
    }
    chart.u = new uPlot(opts, spec.data, el);
    // Color the legend markers as short line keys (identity never by text color).
    el.querySelectorAll(".u-legend .u-series").forEach((row, i) => {
      if (i === 0) return;
      const s = spec.series[i - 1];
      const m = row.querySelector(".u-marker");
      if (m && s) {
        const c = s.colorVar ? cssVar(s.colorVar) : s.color;
        m.style.background = c;
        m.style.border = "0";
      }
    });
  };
  chart.update = (data) => {
    spec.data = data;
    if (chart.u) chart.u.setData(data);
    else build();
  };
  chart.rebuild = build;
  chart.destroy = () => {
    if (chart.u) chart.u.destroy();
    chart.ro?.disconnect();
    registry.delete(chart);
  };
  build();
  chart.ro = new ResizeObserver(() => {
    if (!chart.u) return;
    const w = Math.max(260, spec.el.clientWidth);
    if (Math.abs(w - chart.u.width) > 2) chart.u.setSize({ width: w, height: spec.height ?? 280 });
  });
  chart.ro.observe(spec.el);
  registry.add(chart);
  return chart;
}

export function rebuildAll() {
  for (const c of registry) c.rebuild();
}
