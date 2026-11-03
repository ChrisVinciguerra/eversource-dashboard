/* Eversource energy dashboard.
   Data comes from /api/data; long operations (update, sign-in) run as
   server-side jobs polled via /api/job. Signing in happens in-page: once the
   password is saved, an expired session renews itself with no prompt. */

"use strict";

const $ = (id) => document.getElementById(id);

// The filter picks survive reloads.
const savedRange = localStorage.getItem("range");
const state = {
  data: null,
  res: localStorage.getItem("res") || "quarter_hour", // daily | hourly | quarter_hour
  metric: localStorage.getItem("metric") || "usage",  // usage | cost
  // How the usage chart breaks down known devices:
  //   total   — one net series (devices only show up via the subtract chips)
  //   stacked — each device plus "Everything else", stacked to the total
  //   lines   — each device plus "Everything else" as separate series
  view: localStorage.getItem("view") || "total",
  // number of days or "all"
  rangeDays: savedRange === "all" ? "all" : Number(savedRange) || 1,
  // Known devices whose usage is virtually subtracted from the charts.
  excluded: new Set(JSON.parse(localStorage.getItem("excluded") || "[]")),
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

function excludedDevices(res) {
  const interval = intervalFor(res);
  if (!interval || !interval.devices) return [];
  return interval.devices.filter((dev) => state.excluded.has(dev.name));
}

// Overlap streams (energy two excluded devices both metered) that apply to
// the current exclusion set: both of the pair's names must be excluded.
function activeOverlaps(res) {
  const interval = intervalFor(res);
  if (!interval || !interval.overlaps) return [];
  return interval.overlaps.filter((o) => o.names.every((n) => state.excluded.has(n)));
}

// Sum of the excluded devices' usage/cost per bucket start (ms), to subtract
// from each displayed series. Energy metered by two excluded devices at once
// (the Mac charging from a metered charging station) is counted once.
function excludedOffsets(res) {
  const map = new Map();
  const add = (entry, sign) => {
    for (let i = 0; i < entry.starts.length; i++) {
      const ms = new Date(entry.starts[i]).getTime();
      const cur = map.get(ms) || { value: 0, cost: 0 };
      cur.value += sign * (entry.values[i] ?? 0);
      if (entry.costs) cur.cost += sign * (entry.costs[i] ?? 0);
      map.set(ms, cur);
    }
  };
  for (const dev of excludedDevices(res)) add(dev, 1);
  for (const overlap of activeOverlaps(res)) add(overlap, -1);
  return map.size ? map : null;
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

// "Everything else": the metered total minus every known device (excluded or
// not — a device hidden by its chip disappears from the chart rather than
// melting back into the remainder).
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

function seriesPoints(entry, metric, offsets) {
  const ys = metric === "cost" ? entry.costs : entry.values;
  if (!ys) return null;
  const key = metric === "cost" ? "cost" : "value";
  const pts = new Array(entry.starts.length);
  for (let i = 0; i < entry.starts.length; i++) {
    const ms = new Date(entry.starts[i]).getTime();
    let y = ys[i];
    const off = offsets && y != null ? offsets.get(ms) : null;
    if (off) y = Math.round((y - off[key]) * 1e6) / 1e6;
    pts[i] = [ms, y];
  }
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

  const comps = componentEntries(state.res);
  const split = state.view !== "total" && comps.length > 0;
  const stacked = split && state.view === "stacked";

  // In the component views each entry is already a component, so the
  // exclusion offsets don't apply — a chipped device is simply left out.
  let entries, offsets;
  if (split) {
    const rem = remainderEntry(state.res, comps);
    entries = [rem, ...comps.filter((dev) => !state.excluded.has(dev.name))].filter(Boolean);
    offsets = null;
  } else {
    entries = interval.series;
    offsets = excludedOffsets(state.res);
  }

  const colors = [];
  const series = entries
    .map((entry) => {
      const pts = seriesPoints(entry, metric, offsets);
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

  const minus = excludedDevices(state.res).map((dev) => ` − ${dev.name}`).join("");
  $("usage-title").textContent =
    ({ daily: "Daily", hourly: "Hourly", quarter_hour: "15-minute" }[state.res]) +
    (metric === "cost" ? " cost" : " usage") +
    (split ? " by device" : "") + minus + ` · ${unitLabel}`;
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

// Usage and cost summed over the chart's visible window (exclusions applied).
function windowTotals() {
  const interval = intervalFor(state.res);
  const win = currentWindow();
  if (!win) return null;
  const { from, to } = win;
  const offsets = excludedOffsets(state.res);
  let usage = 0, cost = 0, hasCost = false;
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      const ms = new Date(entry.starts[i]).getTime();
      if (ms < from || ms > to) continue;
      const off = offsets ? offsets.get(ms) : null;
      if (entry.values[i] != null) usage += entry.values[i] - (off ? off.value : 0);
      if (entry.costs && entry.costs[i] != null) {
        cost += entry.costs[i] - (off ? off.cost : 0);
        hasCost = true;
      }
    }
  }
  return { usage, cost: hasCost ? cost : null, unit: interval.unit };
}

function updateWindowSum() {
  const t = windowTotals();
  $("window-sum").textContent = t
    ? `${fmtNum(t.usage)} ${t.unit}${t.cost != null ? ` · ${fmtUsd(t.cost)}` : ""} in view`
    : "";
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

// -------------------------------------------------------------- stat tiles --

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
  // Excluded devices come off the day totals once (not once per stream);
  // overlaps between excluded devices go back so they only come off once.
  const adjust = (entry, sign) => {
    for (let i = 0; i < entry.starts.length; i++) {
      const cur = byDay.get(entry.starts[i].slice(0, 10));
      if (!cur) continue;
      cur.value -= sign * (entry.values[i] ?? 0);
      if (cur.hasCost && entry.costs) cur.cost -= sign * (entry.costs[i] ?? 0);
    }
  };
  for (const dev of excludedDevices("daily")) adjust(dev, 1);
  for (const overlap of activeOverlaps("daily")) adjust(overlap, -1);
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function sumRange(days, from, to, field) {
  let sum = 0, any = false;
  for (const d of days.slice(from, to)) {
    if (d[field] != null) { sum += d[field]; any = true; }
  }
  return any ? sum : null;
}

function tile(label, value, sub, deltaPct) {
  const div = document.createElement("div");
  div.className = "tile";
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

const pct = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);

function renderTiles() {
  const root = $("tiles");
  root.textContent = "";
  const days = dailyTotals();
  const interval = intervalFor("daily");
  const unit = interval ? interval.unit : "";
  if (!days.length) return;

  const n = days.length;
  const latest = days[n - 1];
  const prev = n >= 2 ? days[n - 2] : null;
  const latestDate = new Date(latest.day + "T12:00:00")
    .toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
  root.append(tile(
    `Latest day · ${latestDate}`,
    `${fmtNum(latest.value)} <small>${esc(unit)}</small>`,
    "vs previous day",
    prev ? pct(latest.value, prev.value) : null,
  ));

  const wk = sumRange(days, Math.max(0, n - 7), n, "value");
  const wkPrev = n > 7 ? sumRange(days, Math.max(0, n - 14), n - 7, "value") : null;
  root.append(tile(
    "Last 7 days",
    `${fmtNum(wk)} <small>${esc(unit)}</small>`,
    "vs prior 7 days",
    wkPrev != null ? pct(wk, wkPrev) : null,
  ));

  const moCost = sumRange(days, Math.max(0, n - 30), n, "cost");
  const moCostPrev = n > 30 ? sumRange(days, Math.max(0, n - 60), n - 30, "cost") : null;
  if (moCost != null) {
    root.append(tile(
      "Last 30 days cost (est.)",
      fmtUsd(moCost, 0),
      "vs prior 30 days",
      moCostPrev != null ? pct(moCost, moCostPrev) : null,
    ));
  }

  const bills = state.data.bills;
  if (Array.isArray(bills) && bills.length) {
    const last = [...bills].sort((a, b) => (a.period_end < b.period_end ? -1 : 1)).at(-1);
    const period = new Date(last.period_end + "T12:00:00")
      .toLocaleString("en-US", { month: "short", day: "numeric" });
    root.append(tile(
      `Latest bill · thru ${period}`,
      fmtUsd(last.total_amount_usd),
      last.estimated ? "estimated" : "",
      null,
    ));
  }
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
    const offsets = excludedOffsets(state.res);
    const rows = [];
    for (const entry of interval.series) {
      for (let i = 0; i < entry.starts.length; i++) {
        const off = offsets ? offsets.get(new Date(entry.starts[i]).getTime()) : null;
        rows.push({
          start: entry.starts[i], stream: entry.name,
          value: entry.values[i] == null || !off ? entry.values[i] : entry.values[i] - off.value,
          cost: !entry.costs || entry.costs[i] == null ? null
            : off ? entry.costs[i] - off.cost : entry.costs[i],
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
wireSeg("view-seg", "view", (value) => {
  localStorage.setItem("view", value);
  state.view = value;
  renderUsage();
});

syncSeg("range-seg", "range", state.rangeDays);
syncSeg("res-seg", "res", state.res);
syncSeg("metric-seg", "metric", state.metric);
syncSeg("view-seg", "view", state.view);

// One chip per known device (devices/*.json); active = subtracted from charts.
function renderDeviceChips() {
  const names = deviceNames();
  const root = $("device-chips");
  root.textContent = "";
  root.hidden = !names.length;
  $("view-seg").hidden = !names.length;
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    // Same palette slot as the device's series, so chip and legend match.
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = `var(--series-${(paletteSlot(name) % 4) + 1})`;
    const label = document.createElement("span");
    label.textContent = `− ${name}`;
    btn.append(dot, label);
    btn.title = `Subtract ${name} from the charts`;
    btn.classList.toggle("active", state.excluded.has(name));
    btn.addEventListener("click", () => {
      state.excluded[state.excluded.has(name) ? "delete" : "add"](name);
      localStorage.setItem("excluded", JSON.stringify([...state.excluded]));
      btn.classList.toggle("active", state.excluded.has(name));
      renderAll();
      if (!$("usage-table").hidden) fillTable("usage");
    });
    root.append(btn);
  }
}

// ------------------------------------------------------------ data + jobs --

function renderAll() {
  if (!state.data) return;
  renderTiles();
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
          else {
            sessionStorage.setItem("lastUpdate", String(Date.now()));
            await loadData();
          }
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

function dataIsStale() {
  if (!state.data || !state.data.last_read) return true;
  const today = new Date();
  const localDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return state.data.last_read.slice(0, 10) < localDay(today);
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
  if (job.running) {
    pollJob();
    return;
  }
  // Auto-refresh on open, but not repeatedly within the same browsing session.
  const last = Number(sessionStorage.getItem("lastUpdate") || 0);
  if (dataIsStale() && Date.now() - last > 15 * 60e3) startUpdate();
}

init();
