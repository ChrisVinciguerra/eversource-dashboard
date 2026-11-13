/* Eversource energy dashboard.
   Data comes from /api/data; long operations (update, sign-in) run as
   server-side jobs polled via /api/job. Signing in happens in-page: once the
   password is saved, an expired session renews itself with no prompt. */

"use strict";

const $ = (id) => document.getElementById(id);

// The filter picks survive reloads.
const savedRange = localStorage.getItem("range");
const savedView = localStorage.getItem("view");
const state = {
  data: null,
  res: localStorage.getItem("res") || "quarter_hour", // daily | hourly | quarter_hour
  metric: localStorage.getItem("metric") || "usage",  // usage | cost
  // Device breakdown as separate "lines" (default) or "stacked" areas, or
  // "total": the one net series with every device folded in.
  view: savedView === "stacked" || savedView === "total" ? savedView : "lines",
  rangeDays: savedRange === "all" ? "all" : Number(savedRange) || 1, // days or "all"
  // Known devices left inside "Everything else" instead of broken out.
  folded: new Set(JSON.parse(localStorage.getItem("folded") || "[]")),
};

const charts = {};        // id -> echarts instance

// ------------------------------------------------------------------ theme --

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(localStorage.getItem("theme") || null);

$("theme-btn").addEventListener("click", () => {
  const dark = getComputedStyle(document.body).colorScheme === "dark";
  const next = dark ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
  renderAll();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!localStorage.getItem("theme")) renderAll();
});

function tokens() {
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface-1"),
    textPrimary: v("--text-primary"),
    textSecondary: v("--text-secondary"),
    muted: v("--text-muted"),
    gridline: v("--gridline"),
    baseline: v("--baseline"),
    border: v("--border"),
    series: [v("--series-1"), v("--series-2"), v("--series-3"), v("--series-4")],
  };
}

// ------------------------------------------------------------- formatting --

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtNum(x, digits) {
  if (x == null || Number.isNaN(x)) return "–";
  const d = digits ?? (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2);
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtUsd = (x, digits = 2) => (x == null ? "–" : "$" + fmtNum(x, digits));

const DAY_FMT = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
const TIME_FMT = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

function fmtStamp(ms, res) {
  const d = new Date(ms);
  return d.toLocaleString("en-US", res === "daily" ? DAY_FMT : TIME_FMT);
}

// ------------------------------------------------------------ chart chrome --

function baseOption(t) {
  return {
    color: t.series,
    textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
    grid: { left: 56, right: 16, top: 28, bottom: 52, containLabel: false },
    xAxis: {
      axisLine: { lineStyle: { color: t.baseline } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11.5 },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11.5 },
      splitLine: { lineStyle: { color: t.gridline, width: 1, type: "solid" } },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.surface,
      borderColor: t.gridline,
      borderWidth: 1,
      textStyle: { color: t.textPrimary, fontSize: 12.5 },
      axisPointer: { type: "line", lineStyle: { color: t.baseline, width: 1 } },
    },
  };
}

// A legend only earns its place with two or more series; a single series is
// already named by the card title.
function legendFor(series, t, position) {
  if (series.length < 2) return { show: false };
  return { top: 0, textStyle: { color: t.textSecondary }, ...position };
}

function tooltipRows(params, valueFmt) {
  return params
    .filter((p) => p.value != null && p.value[1] != null)
    .map((p) =>
      `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
         <span style="width:12px;height:2px;background:${p.color};flex:none"></span>
         <strong>${esc(valueFmt(p.value[1]))}</strong>
         <span style="opacity:.75">${esc(p.seriesName)}</span>
       </div>`)
    .join("");
}

// Reuse the instance across renders: updates morph in place instead of
// replaying the entry animation, and the zoom window survives.
function makeChart(id) {
  if (!charts[id]) charts[id] = echarts.init($(id), null, { renderer: "canvas" });
  return charts[id];
}

// Axes and series are rebuilt wholesale each render, so stale pieces (an
// axis formatter, a removed series) don't linger through option merging.
const REPLACE = { replaceMerge: ["xAxis", "yAxis", "series"] };
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

// ------------------------------------------------------------ usage chart --

function intervalFor(res) {
  return state.data && state.data.intervals ? state.data.intervals[res] : null;
}

// Known-device names in a stable order, shared by the chart's component
// series and the filter chips so both map a device to the same palette slot:
// "Everything else" takes slot 0, device i takes slot i + 1 (cycling).
// Toggling a chip therefore never reshuffles colors.
function deviceNames() {
  return [...new Set(
    Object.values(state.data.intervals || {})
      .flatMap((iv) => iv.devices || [])
      .map((dev) => dev.name),
  )];
}

function paletteSlot(name) {
  return name === "Everything else" ? 0 : deviceNames().indexOf(name) + 1;
}

// Device streams with doubly-metered energy attributed exactly once: each
// overlap comes off the first-named device (the meter that also saw another
// known device's draw), so stacking the components never double-counts.
function componentEntries(res) {
  const interval = intervalFor(res);
  if (!interval || !interval.devices) return [];
  const overlaps = interval.overlaps || [];
  return interval.devices.map((dev) => {
    const mine = overlaps.filter((o) => o.names[0] === dev.name);
    if (!mine.length) return dev;
    const values = dev.values.slice();
    const costs = dev.costs ? dev.costs.slice() : null;
    const indexOf = new Map(dev.starts.map((s, i) => [s, i]));
    for (const o of mine) {
      for (let i = 0; i < o.starts.length; i++) {
        const j = indexOf.get(o.starts[i]);
        if (j == null) continue;
        if (values[j] != null)
          values[j] = Math.round((values[j] - (o.values[i] ?? 0)) * 1e6) / 1e6;
        if (costs && o.costs && costs[j] != null)
          costs[j] = Math.round((costs[j] - (o.costs[i] ?? 0)) * 1e6) / 1e6;
      }
    }
    return costs ? { ...dev, values, costs } : { ...dev, values };
  });
}

// "Everything else": the metered total minus the broken-out devices, so the
// components always stack back to the meter reading.
function remainderEntry(res, comps) {
  const interval = intervalFor(res);
  if (!interval || !interval.series.length) return null;
  const totals = new Map(); // ISO start -> { value, cost }
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      const cur = totals.get(entry.starts[i]) || { value: null, cost: null };
      if (entry.values[i] != null) cur.value = (cur.value ?? 0) + entry.values[i];
      if (entry.costs && entry.costs[i] != null) cur.cost = (cur.cost ?? 0) + entry.costs[i];
      totals.set(entry.starts[i], cur);
    }
  }
  for (const dev of comps) {
    for (let i = 0; i < dev.starts.length; i++) {
      const cur = totals.get(dev.starts[i]);
      if (!cur) continue;
      if (cur.value != null) cur.value -= dev.values[i] ?? 0;
      if (cur.cost != null && dev.costs) cur.cost -= dev.costs[i] ?? 0;
    }
  }
  const starts = [...totals.keys()].sort();
  const round = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
  const entry = {
    name: "Everything else",
    starts,
    values: starts.map((k) => round(totals.get(k).value)),
  };
  if (starts.some((k) => totals.get(k).cost != null))
    entry.costs = starts.map((k) => round(totals.get(k).cost));
  return entry;
}

function seriesPoints(entry, metric) {
  const ys = metric === "cost" ? entry.costs : entry.values;
  if (!ys) return null;
  const pts = new Array(entry.starts.length);
  for (let i = 0; i < entry.starts.length; i++)
    pts[i] = [new Date(entry.starts[i]).getTime(), ys[i]];
  return pts;
}

function renderUsage() {
  const t = tokens();
  const interval = intervalFor(state.res);
  const fresh = !charts["usage-chart"];
  const chart = makeChart("usage-chart");
  if (!interval) return;

  const isDaily = state.res === "daily";
  const metric = state.metric;
  const unitLabel = metric === "cost" ? "$" : interval.unit;
  const valueFmt = metric === "cost" ? (x) => fmtUsd(x, isDaily ? 2 : 3) : (x) => `${fmtNum(x)} ${interval.unit}`;

  // Lines/stacked split the meter into each unfolded device plus "Everything
  // else"; total mode (or no known devices) is the plain metered series.
  const comps = state.view === "total" ? [] : componentEntries(state.res);
  const split = comps.length > 0;
  const stacked = split && state.view === "stacked";
  const shown = comps.filter((dev) => !state.folded.has(dev.name));
  const entries = split
    ? [remainderEntry(state.res, shown), ...shown].filter(Boolean)
    : interval.series;

  const colors = [];
  const series = entries
    .map((entry) => {
      const pts = seriesPoints(entry, metric);
      if (!pts) return null;
      colors.push(t.series[paletteSlot(entry.name) % t.series.length]);
      return isDaily
        ? {
            name: entry.name, type: "bar", data: pts,
            barMaxWidth: 24,
            stack: stacked ? "components" : undefined,
            itemStyle: { borderRadius: stacked ? 0 : [4, 4, 0, 0] },
          }
        : {
            name: entry.name, type: "line", data: pts,
            showSymbol: false,
            // Sampling would misalign the stacked buckets, so skip it there.
            sampling: stacked ? undefined : "lttb",
            stack: stacked ? "components" : undefined,
            areaStyle: stacked ? { opacity: 0.35 } : undefined,
            lineStyle: { width: 2 }, symbolSize: 8,
          };
    })
    .filter(Boolean);

  const opt = baseOption(t);
  if (split) opt.color = colors;
  opt.xAxis.type = "time";
  opt.yAxis.name = metric === "cost" ? "Cost ($)" : `Usage (${interval.unit})`;
  opt.yAxis.nameTextStyle = { color: t.textSecondary, align: "left" };
  opt.yAxis.axisLabel.formatter = metric === "cost" ? (v) => "$" + fmtNum(v, v >= 1 ? 0 : 2) : undefined;
  opt.series = series;
  opt.legend = legendFor(series, t, { right: 48 });
  opt.tooltip.formatter = (params) => {
    if (!params.length) return "";
    const rows = params.filter((p) => p.value != null && p.value[1] != null);
    const total = split && rows.length > 1
      ? `<div style="margin-top:4px;padding-top:3px;border-top:1px solid ${t.gridline}">
           <strong>${esc(valueFmt(rows.reduce((sum, p) => sum + p.value[1], 0)))}</strong>
           <span style="opacity:.75">Total</span>
         </div>`
      : "";
    return `<div style="color:${t.textSecondary}">${esc(fmtStamp(params[0].value[0], state.res))}</div>` +
      tooltipRows(params, valueFmt) + total;
  };
  opt.dataZoom = [
    { type: "inside", xAxisIndex: 0 },
    {
      type: "slider", xAxisIndex: 0, height: 24, bottom: 8,
      borderColor: t.gridline, fillerColor: "rgba(42,120,214,0.10)",
      handleStyle: { color: t.surface, borderColor: t.baseline },
      dataBackground: { lineStyle: { color: t.baseline }, areaStyle: { color: t.gridline } },
      textStyle: { color: t.muted, fontSize: 10.5 },
    },
  ];
  chart.setOption(opt, REPLACE);
  // Only a brand-new chart gets the saved range; re-renders (chip, metric,
  // theme, resolution) keep whatever window the user is looking at.
  if (fresh) {
    chart.on("datazoom", () => { updateWindowSum(); syncZoomFine(); });
    applyRange();
  }
  updateWindowSum();
  syncZoomFine();

  $("usage-title").textContent =
    ({ daily: "Daily", hourly: "Hourly", quarter_hour: "15-minute" }[state.res]) +
    (metric === "cost" ? " cost" : " usage") +
    (split ? " by device" : "") + ` · ${unitLabel}`;
}

// The visible zoom window plus the full data extent, all in epoch ms.
function currentWindow() {
  const chart = charts["usage-chart"];
  const interval = intervalFor(state.res);
  if (!chart || !interval || !interval.series.length) return null;
  const dz = (chart.getOption().dataZoom || [])[0];
  if (!dz) return null;
  const allMs = interval.series.flatMap((e) =>
    [new Date(e.starts[0]).getTime(), new Date(e.starts[e.starts.length - 1]).getTime()]);
  const lo = Math.min(...allMs), hi = Math.max(...allMs);
  // The zoom window is stored as values when set by value, percents otherwise.
  const from = dz.startValue ?? lo + ((dz.start ?? 0) / 100) * (hi - lo);
  const to = dz.endValue ?? lo + ((dz.end ?? 100) / 100) * (hi - lo);
  return { from, to, lo, hi };
}

// Usage and cost summed over [from, to] ms, inclusive.
function rangeTotals(from, to) {
  const interval = intervalFor(state.res);
  if (!interval) return null;
  let usage = 0, cost = 0, hasCost = false;
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      const ms = new Date(entry.starts[i]).getTime();
      if (ms < from || ms > to) continue;
      if (entry.values[i] != null) usage += entry.values[i];
      if (entry.costs && entry.costs[i] != null) {
        cost += entry.costs[i];
        hasCost = true;
      }
    }
  }
  return { usage, cost: hasCost ? cost : null, unit: interval.unit };
}

// The hero summary card follows the chart's visible window: total cost (or
// usage when no cost series exists) in view, with a delta against the prior
// window of the same length when the data reaches back that far.
function updateWindowSum() {
  const win = currentWindow();
  const cur = win ? rangeTotals(win.from, win.to) : null;
  const deltaEl = $("hero-delta");
  if (!cur) {
    $("hero-value").textContent = "–";
    $("hero-sub").textContent = "";
    $("hero-meta").textContent = "";
    deltaEl.textContent = "";
    deltaEl.className = "hero-delta";
    return;
  }
  const hasCost = cur.cost != null;
  const width = win.to - win.from;
  const stampFmt = width >= 2 * 86400e3
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  const stamp = (ms) => new Date(ms).toLocaleString("en-US", stampFmt);
  $("hero-label").textContent = hasCost ? "Cost in view" : "Usage in view";
  $("hero-value").innerHTML = hasCost
    ? esc(fmtUsd(cur.cost))
    : `${esc(fmtNum(cur.usage))} <small>${esc(cur.unit)}</small>`;
  $("hero-sub").textContent =
    (hasCost ? `${fmtNum(cur.usage)} ${cur.unit} · ` : "") +
    `${stamp(win.from)} – ${stamp(win.to)}`;

  let deltaPct = null;
  if (win.from - width >= win.lo) {
    const prev = rangeTotals(win.from - width, win.from - 1);
    deltaPct = prev ? pct(hasCost ? cur.cost : cur.usage, hasCost ? prev.cost : prev.usage) : null;
  }
  if (deltaPct != null && Number.isFinite(deltaPct)) {
    deltaEl.className = "hero-delta " + (deltaPct < 0 ? "good" : deltaPct > 0 ? "bad" : "");
    deltaEl.textContent =
      `${deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : ""} ${Math.abs(deltaPct).toFixed(0)}% vs prior period`;
  } else {
    deltaEl.textContent = "";
    deltaEl.className = "hero-delta";
  }

  // Context facts for the window: per-day average (once the window spans
  // multiple days), the effective rate actually paid, and the peak bucket.
  const meta = [];
  const daysInView = width / 86400e3;
  if (daysInView >= 1.5) {
    meta.push(hasCost
      ? `${fmtUsd(cur.cost / daysInView)}/day avg`
      : `${fmtNum(cur.usage / daysInView)} ${cur.unit}/day avg`);
  }
  if (hasCost && cur.usage > 0) meta.push(`${fmtUsd(cur.cost / cur.usage, 2)}/${cur.unit} effective`);
  const peak = windowPeak(win);
  if (peak) {
    meta.push(state.res === "daily"
      ? `peak day ${fmtNum(peak.value)} ${cur.unit} · ${fmtStamp(peak.ms, "daily")}`
      : `peak ${fmtNum(peak.value)} ${cur.unit} · ${fmtStamp(peak.ms, state.res)}`);
  }
  $("hero-meta").textContent = meta.join("  ·  ");
}

// The largest single bucket (summed across streams) inside the visible window.
function windowPeak(win) {
  const interval = intervalFor(state.res);
  if (!interval) return null;
  const totals = new Map();
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      if (entry.values[i] == null) continue;
      const ms = new Date(entry.starts[i]).getTime();
      if (ms < win.from || ms > win.to) continue;
      totals.set(ms, (totals.get(ms) ?? 0) + entry.values[i]);
    }
  }
  let best = null;
  for (const [ms, value] of totals) {
    if (!best || value > best.value) best = { ms, value };
  }
  return best;
}

function applyRange() {
  const chart = charts["usage-chart"];
  const interval = intervalFor(state.res);
  if (!chart || !interval || !interval.series.length) return;
  const starts = interval.series[0].starts;
  const endMs = new Date(starts[starts.length - 1]).getTime();
  if (state.rangeDays === "all") {
    chart.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  } else {
    chart.dispatchAction({
      type: "dataZoom",
      startValue: endMs - state.rangeDays * 86400e3,
      endValue: endMs,
    });
  }
}

// ---------------------------------------------------------- fine zoom strip --
// On the main slider both handles collapse into the same few pixels once the
// window is a sliver of the full range. This strip magnifies the window's
// neighborhood (one window-width of context per side) so start and end stay
// far enough apart to grab one at a time. It re-centers after each drag.

const FINE_SHOW_BELOW = 0.25; // show once the window is under 25% of the range
const fine = { lo: 0, hi: 0, drag: null };

const resMs = () =>
  ({ daily: 86400e3, hourly: 3600e3, quarter_hour: 900e3 }[state.res]);

function syncZoomFine() {
  const el = $("zoom-fine");
  const win = currentWindow();
  const span = win ? win.hi - win.lo : 0;
  const width = win ? win.to - win.from : 0;
  const show = span > 0 && width > 0 && width / span < FINE_SHOW_BELOW;
  el.hidden = !show;
  if (!show) return;
  // Freeze the magnified extent mid-drag so the ground doesn't shift underfoot.
  if (!fine.drag) {
    const pad = Math.max(width, resMs() * 4);
    fine.lo = Math.max(win.lo, win.from - pad);
    fine.hi = Math.min(win.hi, win.to + pad);
  }
  const pct = (ms) =>
    Math.max(0, Math.min(100, ((ms - fine.lo) / (fine.hi - fine.lo)) * 100));
  const a = pct(win.from), b = pct(win.to);
  $("zoom-fine-win").style.left = a + "%";
  $("zoom-fine-win").style.width = (b - a) + "%";
  $("zoom-fine-start").style.left = a + "%";
  $("zoom-fine-end").style.left = b + "%";
  $("zoom-fine-lo").textContent = fmtStamp(fine.lo, state.res);
  $("zoom-fine-hi").textContent = fmtStamp(fine.hi, state.res);
}

$("zoom-fine-track").addEventListener("pointerdown", (event) => {
  const win = currentWindow();
  if (!win) return;
  const track = $("zoom-fine-track");
  const rect = track.getBoundingClientRect();
  const msAt = (x) => fine.lo + ((x - rect.left) / rect.width) * (fine.hi - fine.lo);

  let mode;
  if (event.target === $("zoom-fine-start")) mode = "start";
  else if (event.target === $("zoom-fine-end")) mode = "end";
  else if (event.target === $("zoom-fine-win")) mode = "pan";
  // Bare track: the click moves whichever handle is nearer.
  else mode = Math.abs(msAt(event.clientX) - win.from) <=
              Math.abs(msAt(event.clientX) - win.to) ? "start" : "end";

  fine.drag = { mode, grabFrom: win.from, grabTo: win.to, grabX: event.clientX };
  track.setPointerCapture(event.pointerId);

  const apply = (clientX) => {
    const minGap = resMs();
    let { from, to } = currentWindow();
    if (fine.drag.mode === "pan") {
      const dMs = ((clientX - fine.drag.grabX) / rect.width) * (fine.hi - fine.lo);
      const width = fine.drag.grabTo - fine.drag.grabFrom;
      from = Math.max(fine.lo, Math.min(fine.hi - width, fine.drag.grabFrom + dMs));
      to = from + width;
    } else {
      const ms = Math.max(fine.lo, Math.min(fine.hi, msAt(clientX)));
      if (fine.drag.mode === "start") from = Math.min(ms, to - minGap);
      else to = Math.max(ms, from + minGap);
    }
    charts["usage-chart"].dispatchAction({ type: "dataZoom", startValue: from, endValue: to });
  };

  apply(event.clientX);
  const move = (ev) => apply(ev.clientX);
  const up = () => {
    track.removeEventListener("pointermove", move);
    track.removeEventListener("pointerup", up);
    track.removeEventListener("pointercancel", up);
    fine.drag = null;
    syncZoomFine(); // re-center the magnified extent on the final window
  };
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
});

// --------------------------------------------------- monthly + bills charts --

function monthLabel(iso) {
  return new Date(iso + "T12:00:00").toLocaleString("en-US", { month: "short", year: "2-digit" });
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
}

function renderCategoryBars(id, rows, groupKey, xKey, yKey, valueFmt, yName) {
  const t = tokens();
  const chart = makeChart(id);
  const cats = [...new Set(rows.map((r) => r[xKey]))].sort();
  const groups = groupBy(rows, groupKey);
  const series = [...groups.entries()].map(([name, rws]) => {
    const byX = new Map(rws.map((r) => [r[xKey], r]));
    return {
      name: String(name), type: "bar", barMaxWidth: 24,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      data: cats.map((c) => [c, byX.has(c) ? byX.get(c)[yKey] : null]),
    };
  });
  const opt = baseOption(t);
  opt.xAxis.type = "category";
  opt.xAxis.data = cats;
  opt.xAxis.axisLabel.formatter = (v) => monthLabel(v);
  opt.yAxis.name = yName;
  opt.yAxis.nameTextStyle = { color: t.textSecondary, align: "left" };
  opt.series = series;
  opt.legend = legendFor(series, t, { right: 0 });
  opt.grid.bottom = 36;
  opt.tooltip.formatter = (params) => {
    if (!params.length) return "";
    const period = new Date(params[0].axisValue + "T12:00:00")
      .toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return `<div style="color:${t.textSecondary}">Period ending ${esc(period)}</div>` +
      tooltipRows(params, valueFmt);
  };
  chart.setOption(opt, REPLACE);
  return chart;
}

function renderMonthly() {
  const monthly = state.data.monthly;
  const hasMonthly = Array.isArray(monthly) && monthly.length > 0;
  $("monthly-usage-card").hidden = !hasMonthly;
  $("monthly-charge-card").hidden = !hasMonthly;
  if (!hasMonthly) return;
  const unit = monthly[0].unit || "";
  renderCategoryBars("monthly-usage-chart", monthly, "meter", "period_end", "usage",
    (x) => `${fmtNum(x)} ${unit}`, `Usage (${unit})`);
  renderCategoryBars("monthly-charge-chart", monthly, "meter", "period_end", "charge_usd",
    (x) => fmtUsd(x), "Charges ($)");
}

function renderBills() {
  const bills = state.data.bills;
  const hasBills = Array.isArray(bills) && bills.length > 0;
  $("bills-card").hidden = !hasBills;
  if (!hasBills) return;
  renderCategoryBars("bills-chart", bills, "service_type", "period_end", "total_amount_usd",
    (x) => fmtUsd(x), "Total bill ($)");
}

// ----------------------------------------------------------------- summary --

function dailyTotals() {
  const interval = intervalFor("daily");
  if (!interval || !interval.series.length) return [];
  // Sum across streams per day (usually just net usage).
  const byDay = new Map();
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      const day = entry.starts[i].slice(0, 10);
      const cur = byDay.get(day) || { day, value: 0, cost: 0, hasCost: false };
      cur.value += entry.values[i] ?? 0;
      if (entry.costs && entry.costs[i] != null) { cur.cost += entry.costs[i]; cur.hasCost = true; }
      byDay.set(day, cur);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function sumRange(days, from, to, field) {
  let sum = 0, any = false;
  for (const d of days.slice(from, to)) {
    if (d[field] != null) { sum += d[field]; any = true; }
  }
  return any ? sum : null;
}

const pct = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);

// A quiet secondary stat for the strip under the hero number.
function stat(label, value, sub, deltaPct) {
  const div = document.createElement("div");
  div.className = "stat";
  const l = document.createElement("div"); l.className = "label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "value"; v.innerHTML = value;
  div.append(l, v);
  if (deltaPct != null && Number.isFinite(deltaPct)) {
    const d = document.createElement("div");
    // Less energy / money is good: down shows as good, up as bad.
    d.className = "delta " + (deltaPct < 0 ? "good" : deltaPct > 0 ? "bad" : "");
    d.textContent = `${deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : ""} ${Math.abs(deltaPct).toFixed(0)}% ${sub}`;
    div.append(d);
  } else if (sub) {
    const d = document.createElement("div"); d.className = "delta"; d.textContent = sub;
    div.append(d);
  }
  return div;
}

function renderStats() {
  const root = $("sum-stats");
  root.textContent = "";
  const days = dailyTotals();
  const interval = intervalFor("daily");
  const unit = interval ? interval.unit : "";
  if (!days.length) return;

  const n = days.length;
  const latest = days[n - 1];
  const prev = n >= 2 ? days[n - 2] : null;
  const latestDate = new Date(latest.day + "T12:00:00")
    .toLocaleString("en-US", { month: "short", day: "numeric" });
  root.append(stat(
    `Latest day · ${latestDate}`,
    `${fmtNum(latest.value)} <small>${esc(unit)}</small>`,
    "vs previous day",
    prev ? pct(latest.value, prev.value) : null,
  ));

  const wk = sumRange(days, Math.max(0, n - 7), n, "value");
  const wkPrev = n > 7 ? sumRange(days, Math.max(0, n - 14), n - 7, "value") : null;
  root.append(stat(
    "Last 7 days",
    `${fmtNum(wk)} <small>${esc(unit)}</small>`,
    "vs prior 7 days",
    wkPrev != null ? pct(wk, wkPrev) : null,
  ));

  const moCost = sumRange(days, Math.max(0, n - 30), n, "cost");
  const moCostPrev = n > 30 ? sumRange(days, Math.max(0, n - 60), n - 30, "cost") : null;
  if (moCost != null) {
    root.append(stat(
      "30-day cost (est.)",
      fmtUsd(moCost, 0),
      "vs prior 30 days",
      moCostPrev != null ? pct(moCost, moCostPrev) : null,
    ));
  }

  const base = alwaysOnEstimate(days);
  if (base) {
    root.append(stat(
      "Always-on load",
      `${fmtNum(base.kw * 1000, 0)} <small>W</small>`,
      base.perMo != null ? `≈ ${fmtUsd(base.perMo, 0)}/mo baseline` : "baseline draw",
      null,
    ));
  }

  const bills = state.data.bills;
  if (Array.isArray(bills) && bills.length) {
    const last = [...bills].sort((a, b) => (a.period_end < b.period_end ? -1 : 1)).at(-1);
    const period = new Date(last.period_end + "T12:00:00")
      .toLocaleString("en-US", { month: "short", day: "numeric" });
    root.append(stat(
      `Latest bill · thru ${period}`,
      fmtUsd(last.total_amount_usd),
      last.estimated ? "estimated" : "",
      null,
    ));
  }
}

// Always-on (phantom) load: the 5th-percentile bucket of the last week of
// fine-grained data, read as continuous draw, priced at the recent effective
// rate. Hourly buckets are preferred so appliance cycles (fridge) average in
// rather than being cherry-picked at their off moments. kWh data only.
function alwaysOnEstimate(days) {
  const res = state.data.intervals?.hourly ? "hourly" : state.data.intervals?.quarter_hour ? "quarter_hour" : null;
  if (!res) return null;
  const interval = intervalFor(res);
  if (!interval || interval.unit !== "kWh") return null;
  const hours = res === "hourly" ? 1 : 0.25;
  const totals = new Map();
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      if (entry.values[i] != null)
        totals.set(entry.starts[i], (totals.get(entry.starts[i]) ?? 0) + entry.values[i]);
    }
  }
  const starts = [...totals.keys()].sort();
  const week = starts.slice(-Math.round(7 * 24 / hours)).map((s) => totals.get(s));
  if (week.length < 48 / hours) return null; // need at least ~2 days of buckets
  week.sort((a, b) => a - b);
  const kw = week[Math.floor(week.length * 0.05)] / hours;
  if (!(kw > 0)) return null;
  // Effective rate over the last 30 days of daily totals.
  const n = days.length;
  const moCost = sumRange(days, Math.max(0, n - 30), n, "cost");
  const moUsage = sumRange(days, Math.max(0, n - 30), n, "value");
  const rate = moCost != null && moUsage > 0 ? moCost / moUsage : null;
  return { kw, perMo: rate != null ? kw * 24 * 30.4 * rate : null };
}

// Per-contributor cost (usage if no costs) on the most recent metered day:
// each known device plus "Everything else", with its share of the day.
function dayBreakdown() {
  const interval = intervalFor("daily");
  if (!interval || !interval.series.length) return null;
  const comps = componentEntries("daily");
  if (!comps.length) return null;
  const entries = [remainderEntry("daily", comps), ...comps].filter(Boolean);
  let day = null;
  for (const entry of interval.series) {
    const last = entry.starts[entry.starts.length - 1];
    if (last && (!day || last > day)) day = last;
  }
  if (!day) return null;
  day = day.slice(0, 10);
  // Run-rate window: the 30 days up to and including the shown day.
  const cutoff = new Date(new Date(day + "T12:00:00").getTime() - 30 * 86400e3)
    .toISOString().slice(0, 10);
  const rows = entries
    .map((entry) => {
      let value = null, cost = null, aggValue = 0, aggCost = 0;
      const aggDays = new Set();
      for (let i = 0; i < entry.starts.length; i++) {
        const d = entry.starts[i].slice(0, 10);
        if (d === day) {
          if (entry.values[i] != null) value = (value ?? 0) + entry.values[i];
          if (entry.costs && entry.costs[i] != null) cost = (cost ?? 0) + entry.costs[i];
        }
        if (d > cutoff && d <= day && entry.values[i] != null) {
          aggDays.add(d);
          aggValue += entry.values[i];
          if (entry.costs && entry.costs[i] != null) aggCost += entry.costs[i];
        }
      }
      return { name: entry.name, value, cost, aggValue, aggCost, aggDays: aggDays.size };
    })
    .filter((row) => row.value != null || row.cost != null);
  if (!rows.length) return null;
  const hasCost = rows.some((row) => row.cost != null);
  const amount = (row) => (hasCost ? row.cost : row.value) ?? 0;
  rows.sort((a, b) => amount(b) - amount(a));
  return { day, rows, hasCost, unit: interval.unit, total: rows.reduce((s, r) => s + amount(r), 0) };
}

function renderBreakdown() {
  const card = $("breakdown-card");
  const bk = dayBreakdown();
  card.hidden = !bk;
  if (!bk) return;
  const t = tokens();
  const fmt = bk.hasCost ? (x) => fmtUsd(x) : (x) => `${fmtNum(x)} ${bk.unit}`;
  $("breakdown-label").textContent = bk.hasCost ? "Cost by device" : "Usage by device";
  const dayLabel = new Date(bk.day + "T12:00:00")
    .toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
  $("breakdown-day").textContent = `${dayLabel} · ${fmt(bk.total)} total`;

  const list = $("breakdown-list");
  list.textContent = "";
  const cell = (cls, text) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    return span;
  };

  const head = document.createElement("li");
  head.className = "bk-head";
  head.append(cell("", ""), cell("bk-name", "Source"), cell("bk-share", "Share"),
    cell("bk-value", "Day"), cell("bk-permo", "Est. / mo"));
  list.append(head);

  for (const row of bk.rows) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "bk-dot";
    dot.style.background = t.series[paletteSlot(row.name) % t.series.length];
    const amount = (bk.hasCost ? row.cost : row.value) ?? 0;
    const share = bk.total > 0 ? `${((amount / bk.total) * 100).toFixed(0)}%` : "";
    // Monthly run-rate from the row's 30-day daily average.
    const aggAmt = bk.hasCost ? row.aggCost : row.aggValue;
    const perMo = row.aggDays >= 2 ? (aggAmt / row.aggDays) * 30.4 : null;
    const perMoText = perMo == null ? "–"
      : bk.hasCost ? `≈ ${fmtUsd(perMo, perMo >= 10 ? 0 : 2)}`
      : `≈ ${fmtNum(perMo, 0)} ${bk.unit}`;
    li.append(dot,
      cell("bk-name", row.name),
      cell("bk-share", share),
      cell("bk-value", fmt(bk.hasCost ? row.cost : row.value)),
      cell("bk-permo", perMoText));
    list.append(li);
  }
}

function renderSummary() {
  renderStats();
  renderBreakdown();
  updateWindowSum();
}

// ------------------------------------------------------------- table views --

const TABLE_LIMIT = 1000;

function buildTable(container, columns, rows, note) {
  container.textContent = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      td.textContent = col.fmt ? col.fmt(row[col.key]) : (row[col.key] ?? "–");
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
  if (note) {
    const p = document.createElement("div");
    p.className = "table-note";
    p.textContent = note;
    container.append(p);
  }
}

function fillTable(name) {
  if (name === "usage") {
    const interval = intervalFor(state.res);
    if (!interval) return;
    const rows = [];
    for (const entry of interval.series) {
      for (let i = 0; i < entry.starts.length; i++) {
        rows.push({
          start: entry.starts[i], stream: entry.name,
          value: entry.values[i],
          cost: !entry.costs || entry.costs[i] == null ? null : entry.costs[i],
        });
      }
    }
    rows.sort((a, b) => (a.start < b.start ? -1 : 1));
    const shown = rows.slice(-TABLE_LIMIT);
    buildTable($("usage-table"), [
      { key: "start", label: "Start", fmt: (v) => fmtStamp(new Date(v).getTime(), state.res) },
      { key: "stream", label: "Series" },
      { key: "value", label: `Usage (${interval.unit})`, fmt: (v) => fmtNum(v, 3) },
      { key: "cost", label: "Cost ($)", fmt: (v) => (v == null ? "–" : fmtNum(v, 3)) },
    ], shown,
    rows.length > shown.length ? `Showing the most recent ${TABLE_LIMIT} of ${rows.length} rows.` : null);
  } else if (name === "monthly-usage" || name === "monthly-charge") {
    const monthly = state.data.monthly || [];
    buildTable($(name + "-table"), [
      { key: "period_end", label: "Period end" },
      { key: "meter", label: "Meter" },
      { key: "days", label: "Days" },
      { key: "usage", label: `Usage (${monthly[0]?.unit ?? ""})` },
      { key: "charge_usd", label: "Charges ($)", fmt: (v) => fmtNum(v, 2) },
      { key: "avg_daily_temp_f", label: "Avg temp (°F)" },
    ], monthly);
  } else if (name === "bills") {
    buildTable($("bills-table"), [
      { key: "period_start", label: "Period start" },
      { key: "period_end", label: "Period end" },
      { key: "service_type", label: "Service" },
      { key: "usage", label: "Usage" },
      { key: "unit", label: "Unit" },
      { key: "usage_charges_usd", label: "Usage charges ($)", fmt: (v) => fmtNum(v, 2) },
      { key: "total_amount_usd", label: "Total ($)", fmt: (v) => fmtNum(v, 2) },
      { key: "estimated", label: "Estimated", fmt: (v) => (v ? "yes" : "no") },
    ], state.data.bills || []);
  }
}

document.querySelectorAll(".table-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.for;
    const wrap = $(name + "-table");
    const showing = !wrap.hidden;
    wrap.hidden = showing;
    btn.textContent = showing ? "Table" : "Chart view";
    if (!showing) fillTable(name);
  });
});

// ---------------------------------------------------------------- filters --

function wireSeg(id, attr, onPick) {
  $(id).addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    onPick(btn.dataset[attr]);
  });
}

function syncSeg(id, attr, value) {
  $(id).querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset[attr] === String(value)));
}

wireSeg("range-seg", "range", (value) => {
  localStorage.setItem("range", value);
  state.rangeDays = value === "all" ? "all" : Number(value);
  applyRange();
});
wireSeg("res-seg", "res", (value) => {
  localStorage.setItem("res", value);
  state.res = value;
  renderUsage();
  if (!$("usage-table").hidden) fillTable("usage");
});
wireSeg("metric-seg", "metric", (value) => {
  localStorage.setItem("metric", value);
  state.metric = value;
  renderUsage();
});
// Total mode folds every device in, so the chips go inert until it's left.
function syncChipState() {
  $("device-chips").classList.toggle("off", state.view === "total");
}

wireSeg("view-seg", "view", (value) => {
  localStorage.setItem("view", value);
  state.view = value;
  syncChipState();
  renderUsage();
});

syncSeg("range-seg", "range", state.rangeDays);
syncSeg("res-seg", "res", state.res);
syncSeg("metric-seg", "metric", state.metric);
syncSeg("view-seg", "view", state.view);

// One chip per known device (devices/*.json); active = broken out as its own
// series, inactive = folded into "Everything else". Toggling one never
// changes a total, only how the meter is sliced.
function renderDeviceChips() {
  const names = deviceNames();
  const root = $("device-chips");
  root.textContent = "";
  root.hidden = !names.length;
  $("view-seg").hidden = !names.length;
  syncChipState();
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    // Same palette slot as the device's series, so chip and legend match.
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = `var(--series-${(paletteSlot(name) % 4) + 1})`;
    const label = document.createElement("span");
    label.textContent = name;
    btn.append(dot, label);
    btn.title = `Break ${name} out of "Everything else"`;
    btn.classList.toggle("active", !state.folded.has(name));
    btn.addEventListener("click", () => {
      state.folded[state.folded.has(name) ? "delete" : "add"](name);
      localStorage.setItem("folded", JSON.stringify([...state.folded]));
      btn.classList.toggle("active", !state.folded.has(name));
      renderUsage();
    });
    root.append(btn);
  }
}

// ------------------------------------------------------------ data + jobs --

function renderAll() {
  if (!state.data) return;
  renderSummary();
  renderUsage();
  renderMonthly();
  renderBills();
}

async function loadData() {
  const response = await fetch("/api/data");
  state.data = await response.json();
  const empty = !state.data.intervals || !Object.keys(state.data.intervals).length;
  $("empty-note").hidden = !empty;
  if (empty) {
    $("empty-note").textContent =
      "No data yet — the first update fetches your last year of usage.";
  }
  if (state.data.last_read) {
    const through = new Date(state.data.last_read);
    $("data-through").textContent =
      "Data through " + through.toLocaleString("en-US", TIME_FMT);
  } else {
    $("data-through").textContent = "";
  }
  $("stale-badge").hidden = !dataIsStale();
  // Cost toggle only makes sense when a cost series exists.
  const anyCost = Object.values(state.data.intervals || {})
    .some((iv) => iv.series.some((s) => s.costs));
  $("metric-seg").hidden = !anyCost;
  if (!anyCost && state.metric === "cost") {
    state.metric = "usage";
    syncSeg("metric-seg", "metric", "usage");
  }
  renderDeviceChips();
  renderAll();
}

function setBanner({ text, spinning = false, error = false, login = false }) {
  const banner = $("banner");
  banner.hidden = !text && !login;
  banner.classList.toggle("error", error);
  $("banner-text").textContent = text || "";
  $("banner-spinner").hidden = !spinning;
  $("login-btn").hidden = !login;
}

let polling = false;
let mfaAsked = false;

async function pollJob() {
  if (polling) return;
  polling = true;
  $("update-btn").disabled = true;
  document.querySelectorAll(".chart").forEach((el) => el.classList.add("loading"));
  try {
    for (;;) {
      const job = await (await fetch("/api/job")).json();
      if (!job.running) {
        if (job.error && job.needs_login) {
          setBanner({ text: "Your Eversource session has expired.", login: true });
          openLogin();
        } else if (job.error) {
          setBanner({ text: job.error, error: true });
          if (job.kind === "login") openLogin(job.error);
        } else {
          setBanner({});
          if (job.kind === "login") startUpdate();
          else await loadData();
        }
        return;
      }
      if (job.needs_mfa && !mfaAsked) {
        mfaAsked = true;
        $("mfa-note").textContent = job.mfa_prompt || "";
        $("mfa-dialog").showModal();
      }
      const last = job.log.length ? job.log[job.log.length - 1].split("\n")[0] : "Working…";
      setBanner({ text: last, spinning: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    polling = false;
    $("update-btn").disabled = false;
    document.querySelectorAll(".chart").forEach((el) => el.classList.remove("loading"));
  }
}

async function startUpdate() {
  sessionStorage.setItem("lastUpdate", String(Date.now()));
  await fetch("/api/update", { method: "POST" });
  pollJob();
}

/* -------------------------------------------------------------- sign-in --- */

async function openLogin(error) {
  const session = await (await fetch("/api/session")).json();
  // Credentials are already saved: re-auth needs nothing from the user.
  if (session.ready && !error) {
    startLogin({});
    return;
  }
  $("login-username").value = session.username || "";
  $("login-password").value = "";
  $("login-error").textContent = error || "";
  $("login-error").hidden = !error;
  if (!$("login-dialog").open) $("login-dialog").showModal();
  ($("login-username").value ? $("login-password") : $("login-username")).focus();
}

async function startLogin(body) {
  mfaAsked = false;
  setBanner({ text: "Signing in…", spinning: true });
  await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  pollJob();
}

$("update-btn").addEventListener("click", startUpdate);
$("login-btn").addEventListener("click", () => openLogin());

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("login-dialog").close();
  startLogin({
    username: $("login-username").value.trim(),
    password: $("login-password").value,
  });
});
$("login-cancel").addEventListener("click", () => $("login-dialog").close());

$("mfa-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("mfa-code").value.trim();
  $("mfa-code").value = "";
  $("mfa-dialog").close();
  await fetch("/api/mfa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
});

// Newer data should exist by now, judged by the historical posting pattern
// (reads arrive in increment_minutes blocks, typical_lag_minutes after they
// end — learned server-side from past exports).
function dataIsStale() {
  const last = state.data?.last_read;
  if (!last) return true;
  const f = state.data.freshness;
  if (!f) return last.slice(0, 10) < new Date().toLocaleDateString("en-CA");
  const inc = f.increment_minutes * 60e3;
  const avail = Date.now() - f.typical_lag_minutes * 60e3;
  const midnight = new Date(avail).setHours(0, 0, 0, 0);
  const expected = midnight + Math.floor((avail - midnight) / inc) * inc;
  return new Date(last).getTime() < expected;
}

// Show the badge whenever the data is out of date, and (gently) refresh:
// at most one auto-update per 15 minutes, never on top of a running job.
function checkFreshness() {
  const stale = dataIsStale();
  $("stale-badge").hidden = !stale;
  const last = Number(sessionStorage.getItem("lastUpdate") || 0);
  if (stale && !polling && Date.now() - last > 15 * 60e3) startUpdate();
}

// Re-pull device specs that name a remote source (the server may be asleep,
// so this runs after first paint and quietly keeps the cached specs on
// failure); reload if anything actually changed.
async function refreshDevices() {
  try {
    const result = await (await fetch("/api/refresh-devices", { method: "POST" })).json();
    if (result.changed) await loadData();
  } catch {
    /* best effort */
  }
}

async function init() {
  await loadData();
  refreshDevices();
  const job = await (await fetch("/api/job")).json();
  if (job.running) pollJob();
  else checkFreshness();
  setInterval(checkFreshness, 60e3);
}

init();
