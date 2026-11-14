/* Eversource energy dashboard — "two altitudes" layout.
   The billing cycle and a single day are both always on screen: the overview
   chart (one bar per day) is the navigation, clicking a day puts it under the
   15-minute microscope below. A side rail carries the cycle pace, the device
   breakdown, and anomaly flags; one generated sentence narrates the month.
   Data comes from /api/data; long operations (update, sign-in) run as
   server-side jobs polled via /api/job. */

"use strict";

const $ = (id) => document.getElementById(id);

// The filter picks survive reloads.
const savedView = localStorage.getItem("view");
const state = {
  data: null,
  metric: localStorage.getItem("metric") || "usage", // usage | cost
  // Device breakdown as separate series (default), "stacked" areas, or
  // "total": the one net series with every device folded in.
  view: savedView === "stacked" || savedView === "total" ? savedView : "lines",
  // Known devices left inside "Everything else" instead of broken out.
  folded: new Set(JSON.parse(localStorage.getItem("folded") || "[]")),
  cycleIdx: 0,        // 0 = newest window (the running cycle)
  selectedDay: null,  // "YYYY-MM-DD" under the microscope
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
    series: [v("--series-1"), v("--series-2"), v("--series-3"), v("--series-4")],
  };
}

// ------------------------------------------------------------- formatting --

const getJson = async (url) => (await fetch(url)).json();
const postJson = (url, body) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

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

// Day-string helpers: days are "YYYY-MM-DD" in the data's local time.
const dayDate = (day) => new Date(day + "T12:00:00");
const dayMs = (day) => new Date(day + "T00:00:00").getTime();
function addDays(day, n) {
  const d = dayDate(day);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400e3);
const fmtDay = (day, opts) =>
  dayDate(day).toLocaleString("en-US", opts || { month: "short", day: "numeric" });

// ------------------------------------------------------------ chart chrome --

function baseOption(t) {
  return {
    color: t.series,
    textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
    grid: { left: 56, right: 16, top: 28, bottom: 28, containLabel: false },
    xAxis: {
      axisLine: { lineStyle: { color: t.baseline } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11.5 },
      splitLine: { show: false },
    },
    yAxis: {
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11.5 },
      nameTextStyle: { color: t.textSecondary, align: "left" },
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
function legendFor(series, t) {
  if (series.length < 2) return { show: false };
  return { top: 0, right: 0, textStyle: { color: t.textSecondary } };
}

// Metric-dependent y-axis labeling shared by the usage/cost charts.
function metricYAxis(opt, unit) {
  opt.yAxis.name = state.metric === "cost" ? "Cost ($)" : `Usage (${unit})`;
  if (state.metric === "cost")
    opt.yAxis.axisLabel.formatter = (v) => "$" + fmtNum(v, v >= 1 ? 0 : 2);
}

function tooltipRows(params, valueFmt) {
  return params
    .filter((p) => p.value != null && (Array.isArray(p.value) ? p.value[1] : p.value) != null)
    .map((p) => {
      const v = Array.isArray(p.value) ? p.value[1] : p.value;
      return `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
         <span style="width:12px;height:2px;background:${p.color};flex:none"></span>
         <strong>${esc(valueFmt(v))}</strong>
         <span style="opacity:.75">${esc(p.seriesName)}</span>
       </div>`;
    })
    .join("");
}

// Reuse the instance across renders: updates morph in place instead of
// replaying the entry animation.
function makeChart(id) {
  if (!charts[id]) charts[id] = echarts.init($(id), null, { renderer: "canvas" });
  return charts[id];
}

// Axes and series are rebuilt wholesale each render, so stale pieces (an
// axis formatter, a removed series) don't linger through option merging.
const REPLACE = { replaceMerge: ["xAxis", "yAxis", "series"] };
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

// ------------------------------------------------------------ data shapes --

function intervalFor(res) {
  return state.data && state.data.intervals ? state.data.intervals[res] : null;
}

// The finest sub-daily dataset, for the day-under-the-microscope chart.
const detailRes = () => ["quarter_hour", "hourly"].find((r) => intervalFor(r)) || null;

// Known-device names in a stable order, shared by the chart's component
// series and the filter chips so both map a device to the same palette slot:
// "Everything else" takes slot 0, device i takes slot i + 1 (cycling).
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
const slotColor = (t, name) => t.series[paletteSlot(name) % t.series.length];

// Device streams with doubly-metered energy attributed exactly once: each
// overlap comes off the first-named device, so stacking never double-counts.
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

// The split of the meter the current view asks for: each unfolded device plus
// "Everything else", or the plain metered series in total mode / no devices.
function viewEntries(res) {
  const interval = intervalFor(res);
  if (!interval) return { entries: [], split: false };
  const comps = state.view === "total" ? [] : componentEntries(res);
  const shown = comps.filter((dev) => !state.folded.has(dev.name));
  if (!comps.length) return { entries: interval.series, split: false };
  return {
    entries: [remainderEntry(res, shown), ...shown].filter(Boolean),
    split: true,
  };
}

function dailyTotals() {
  const interval = intervalFor("daily");
  if (!interval || !interval.series.length) return [];
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

// All data days in order, for day paging and the "newest day" default.
const dayList = () => dailyTotals().map((d) => d.day);

// --------------------------------------------------------- billing cycles --

// Bills for the metered commodity, oldest first.
function meteredBills() {
  const bills = state.data.bills || [];
  const unit = intervalFor("daily")?.unit;
  return bills
    .filter((b) => (!unit || b.unit === unit) && b.usage > 0)
    .sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
}

// Typical cycle length in days, from the bills themselves.
function typicalCycleLen(bills) {
  const lens = bills
    .map((b) => daysBetween(b.period_start, b.period_end))
    .filter((n) => n > 10)
    .sort((a, b) => a - b);
  return lens.length ? lens[Math.floor(lens.length / 2)] : 30;
}

// The overview's pages, newest first: the running (unbilled) cycle, then one
// window per bill. Without bills, calendar months.
function cycleWindows() {
  const days = dailyTotals();
  if (!days.length) return [];
  const lastDay = days[days.length - 1].day;
  const bills = meteredBills();
  const wins = [];
  if (bills.length) {
    // Bill periods are end-exclusive (each period_end is the next
    // period_start), so a bill's last day is period_end - 1 and the running
    // cycle starts on the newest period_end itself.
    const newest = bills[bills.length - 1];
    const start = newest.period_end;
    if (start <= lastDay) {
      wins.push({ start, end: lastDay, current: true, label: "This cycle" });
    }
    for (let i = bills.length - 1; i >= 0; i--) {
      const b = bills[i];
      const end = addDays(b.period_end, -1);
      wins.push({
        start: b.period_start,
        end,
        bill: b,
        label: `Cycle ending ${fmtDay(end)}`,
      });
    }
  } else {
    const months = [...new Set(days.map((d) => d.day.slice(0, 7)))].sort().reverse();
    for (const m of months) {
      wins.push({
        start: m + "-01",
        end: addDays(addDays(m + "-01", 32).slice(0, 7) + "-01", -1),
        label: dayDate(m + "-15").toLocaleString("en-US", { month: "long", year: "numeric" }),
        current: m === lastDay.slice(0, 7),
      });
    }
  }
  return wins.filter((w) => days.some((d) => d.day >= w.start && d.day <= w.end));
}

function currentWin() {
  const wins = cycleWindows();
  if (!wins.length) return null;
  state.cycleIdx = Math.min(state.cycleIdx, wins.length - 1);
  return wins[state.cycleIdx];
}

const windowDays = (win) =>
  dailyTotals().filter((d) => d.day >= win.start && d.day <= win.end);

// Pace facts for the running cycle: how far in, the projection, and the
// comparison against the last billed cycle.
function cycleFacts() {
  const wins = cycleWindows();
  const win = wins.find((w) => w.current);
  if (!win) return null;
  const days = windowDays(win);
  if (!days.length) return null;
  const bills = meteredBills();
  const lastBill = bills[bills.length - 1] || null;
  const cycleLen = typicalCycleLen(bills);
  const elapsed = daysBetween(win.start, days[days.length - 1].day) + 1;
  const usage = days.reduce((s, d) => s + d.value, 0);
  const cost = days.some((d) => d.hasCost) ? days.reduce((s, d) => s + d.cost, 0) : null;
  const projUsage = elapsed > 0 ? (usage / elapsed) * cycleLen : null;
  const rate = lastBill ? lastBill.total_amount_usd / lastBill.usage : null;
  return {
    win, elapsed, cycleLen,
    daysLeft: Math.max(0, cycleLen - elapsed),
    endEst: addDays(win.start, cycleLen - 1),
    usage, cost, projUsage,
    projCost: projUsage != null && rate != null ? projUsage * rate : null,
    vsLastPct: projUsage != null && lastBill ? ((projUsage - lastBill.usage) / lastBill.usage) * 100 : null,
    lastBill,
    unit: intervalFor("daily")?.unit || "kWh",
  };
}

// Always-on (phantom) load: the 5th-percentile bucket of the last week of
// fine-grained data, read as continuous draw. Hourly buckets are preferred so
// appliance cycles average in rather than being cherry-picked at their off
// moments. kWh data only.
function alwaysOnEstimate() {
  const res = ["hourly", "quarter_hour"].find((r) => intervalFor(r));
  const interval = res && intervalFor(res);
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
  return kw > 0 ? kw : null;
}

// ---------------------------------------------------------------- tagline --

// One sentence narrating the running cycle; strong tags wrap only numbers we
// formatted ourselves.
function renderTagline() {
  const el = $("tagline");
  const f = cycleFacts();
  if (!f) { el.hidden = true; return; }
  const parts = [];
  parts.push(`${f.elapsed} day${f.elapsed === 1 ? "" : "s"} into the billing cycle — ` +
    `${fmtNum(f.usage, 0)} ${esc(f.unit)} so far`);
  if (f.projUsage != null) {
    // Bold only the headline number: the projected cost, or usage without one.
    parts.push(f.projCost != null
      ? `tracking ~${fmtNum(f.projUsage, 0)} ${esc(f.unit)} (<strong>~${fmtUsd(f.projCost, 0)}</strong>)`
      : `tracking <strong>~${fmtNum(f.projUsage, 0)} ${esc(f.unit)}</strong>`);
  }
  if (f.vsLastPct != null && Number.isFinite(f.vsLastPct)) {
    const over = f.vsLastPct > 0;
    parts.push(`<strong class="${over ? "delta-bad" : "delta-good"}">` +
      `${Math.abs(f.vsLastPct).toFixed(0)}% ${over ? "over" : "under"}</strong> last cycle`);
  }
  let text = parts.join(", ") + `. Bill in about ${f.daysLeft} days.`;
  const flags = state.data.flags || [];
  if (flags.length) {
    text += ` ⚑ ${flags.length} thing${flags.length === 1 ? "" : "s"} worth a look.`;
  }
  el.innerHTML = text;
  el.hidden = false;
}

// --------------------------------------------------------- overview chart --

function overviewFlagsByDay() {
  const out = new Map();
  for (const flag of state.data.flags || []) {
    let d = flag.date;
    while (d <= flag.end_date) {
      if (!out.has(d)) out.set(d, flag);
      d = addDays(d, 1);
    }
  }
  return out;
}

function renderOverview() {
  const t = tokens();
  const chart = makeChart("overview-chart");
  const win = currentWin();
  const daily = intervalFor("daily");
  if (!win || !daily) return;
  const metric = state.metric;
  const valueFmt = metric === "cost" ? (x) => fmtUsd(x) : (x) => `${fmtNum(x)} ${daily.unit}`;

  const days = windowDays(win).map((d) => d.day);
  // The in-progress day (newest data day inside the running cycle) renders
  // dimmed so a short bar reads as partial, not an anomaly.
  const newestDay = dayList().at(-1);
  const partialDay =
    win.current && newestDay && days[days.length - 1] === newestDay ? newestDay : null;
  const { entries, split } = viewEntries("daily");
  const stacked = split && state.view === "stacked";

  // Per-entry day sums, so each series lines up on the same category axis.
  const perDay = entries.map((entry) => {
    const map = new Map();
    const ys = metric === "cost" ? entry.costs : entry.values;
    if (!ys) return null;
    for (let i = 0; i < entry.starts.length; i++) {
      if (ys[i] != null) {
        const day = entry.starts[i].slice(0, 10);
        map.set(day, (map.get(day) ?? 0) + ys[i]);
      }
    }
    return map;
  });

  const colors = [];
  const series = entries
    .map((entry, idx) => {
      const map = perDay[idx];
      if (!map) return null;
      colors.push(slotColor(t, entry.name));
      return {
        name: entry.name,
        type: "bar",
        barMaxWidth: 22,
        stack: stacked ? "components" : undefined,
        itemStyle: { borderRadius: stacked ? 0 : [3, 3, 0, 0] },
        data: days.map((day) => {
          const v = map.has(day) ? Math.round(map.get(day) * 1e4) / 1e4 : null;
          const style = {};
          if (day === state.selectedDay) {
            style.borderColor = t.textPrimary;
            style.borderWidth = 1.5;
          }
          if (day === partialDay) style.opacity = 0.45;
          return Object.keys(style).length ? { value: v, itemStyle: style } : v;
        }),
      };
    })
    .filter(Boolean);

  // Flag pins float above the day's total bar.
  const flagsByDay = overviewFlagsByDay();
  const dayTotals = new Map(windowDays(win).map((d) =>
    [d.day, metric === "cost" && d.hasCost ? d.cost : d.value]));
  const pins = days
    .filter((day) => flagsByDay.has(day))
    .map((day) => ({
      coord: [day, (dayTotals.get(day) ?? 0) * 1.02],
      flagDate: flagsByDay.get(day).date,
    }));
  if (series.length && pins.length) {
    series[0].markPoint = {
      symbol: "circle", symbolSize: 1, silent: false,
      label: { show: true, formatter: "⚑", fontSize: 13, color: t.series[3], offset: [0, -8] },
      data: pins,
    };
  }

  const opt = baseOption(t);
  if (split) opt.color = colors;
  opt.xAxis.type = "category";
  opt.xAxis.data = days;
  opt.xAxis.axisLabel.formatter = (v) => fmtDay(v, { day: "numeric" });
  metricYAxis(opt, daily.unit);
  opt.series = series;
  opt.legend = legendFor(series, t);
  opt.tooltip.formatter = (params) => {
    if (!params.length) return "";
    const day = params[0].axisValue;
    const flag = flagsByDay.get(day);
    const note = flag
      ? `<div style="color:${t.series[3]};margin-top:3px">⚑ ${esc(flag.headline)}</div>` : "";
    return `<div style="color:${t.textSecondary}">${esc(fmtDay(day, DAY_FMT))}` +
      ` · click to inspect</div>` + tooltipRows(params, valueFmt) + note;
  };
  chart.setOption(opt, REPLACE);
  chart.off("click");
  chart.on("click", (p) => {
    if (p.componentType === "markPoint" && p.data?.flagDate) selectDay(p.data.flagDate);
    else if (p.componentType === "series") selectDay(days[p.dataIndex]);
  });

  // Title and totals for the window.
  const totals = windowDays(win);
  const usage = totals.reduce((s, d) => s + d.value, 0);
  const cost = totals.some((d) => d.hasCost) ? totals.reduce((s, d) => s + d.cost, 0) : null;
  $("overview-title").textContent = win.label;
  $("overview-sub").textContent =
    `${fmtDay(win.start)} – ${fmtDay(win.end)} · ${fmtNum(usage, 0)} ${daily.unit}` +
    (cost != null ? ` · ${fmtUsd(cost, 0)}` : "") +
    (win.bill ? ` · billed ${fmtUsd(win.bill.total_amount_usd)}` : "");

  const wins = cycleWindows();
  $("cycle-prev").disabled = state.cycleIdx >= wins.length - 1;
  $("cycle-next").disabled = state.cycleIdx <= 0;
}

// ----------------------------------------------------------- detail chart --

function sliceDay(entry, day) {
  const starts = [], values = [], costs = entry.costs ? [] : null;
  for (let i = 0; i < entry.starts.length; i++) {
    if (entry.starts[i].slice(0, 10) !== day) continue;
    starts.push(entry.starts[i]);
    values.push(entry.values[i]);
    if (costs) costs.push(entry.costs[i]);
  }
  return costs ? { ...entry, starts, values, costs } : { ...entry, starts, values };
}

function renderDetail() {
  const res = detailRes();
  $("detail-card").hidden = !res;
  if (!res) return;
  const t = tokens();
  const chart = makeChart("detail-chart");
  const interval = intervalFor(res);
  const day = state.selectedDay;
  if (!day) return;
  const metric = state.metric;
  const valueFmt = metric === "cost" ? (x) => fmtUsd(x, 3) : (x) => `${fmtNum(x)} ${interval.unit}`;

  const { entries, split } = viewEntries(res);
  const dayEntries = entries.map((e) => sliceDay(e, day)).filter((e) => e.starts.length);
  const stacked = split && state.view === "stacked";

  const colors = [];
  const series = dayEntries
    .map((entry) => {
      const ys = metric === "cost" ? entry.costs : entry.values;
      if (!ys) return null;
      colors.push(slotColor(t, entry.name));
      return {
        name: entry.name,
        type: "line",
        showSymbol: false,
        stack: stacked ? "components" : undefined,
        areaStyle: stacked ? { opacity: 0.35 } : undefined,
        lineStyle: { width: 2 },
        symbolSize: 8,
        data: entry.starts.map((s, i) => [new Date(s).getTime(), ys[i]]),
      };
    })
    .filter(Boolean);

  // An overnight-baseline flag covering this day shades its 1–5am window.
  const overnight = (state.data.flags || []).find(
    (f) => f.kind === "overnight_baseline" && f.date <= day && day <= f.end_date);
  if (series.length && overnight) {
    series[0].markArea = {
      silent: true,
      itemStyle: { color: t.series[3], opacity: 0.12 },
      label: { show: true, position: "insideTop", color: t.muted, fontSize: 11,
               formatter: "⚑ overnight load" },
      data: [[{ xAxis: dayMs(day) + 3600e3 }, { xAxis: dayMs(day) + 5 * 3600e3 }]],
    };
  }

  // A subtle "now" line at the last data bucket when the newest day is up,
  // keeping the full 24h frame so the empty remainder reads as "not yet".
  if (series.length && day === dayList().at(-1)) {
    let lastTs = null;
    for (const entry of dayEntries) {
      for (const s of entry.starts) {
        const ts = new Date(s).getTime();
        if (lastTs == null || ts > lastTs) lastTs = ts;
      }
    }
    if (lastTs != null) {
      series[0].markLine = {
        silent: true,
        symbol: "none",
        lineStyle: { color: t.baseline, width: 1, type: "dashed" },
        label: { show: true, formatter: "now", color: t.muted, fontSize: 10, position: "insideEndTop" },
        data: [{ xAxis: lastTs }],
      };
    }
  }

  const opt = baseOption(t);
  if (split) opt.color = colors;
  opt.xAxis.type = "time";
  opt.xAxis.min = dayMs(day);
  opt.xAxis.max = dayMs(day) + 86400e3;
  metricYAxis(opt, interval.unit);
  opt.series = series;
  opt.legend = legendFor(series, t);
  opt.tooltip.formatter = (params) => {
    if (!params.length) return "";
    const rows = params.filter((p) => p.value != null && p.value[1] != null);
    const total = split && rows.length > 1
      ? `<div style="margin-top:4px;padding-top:3px;border-top:1px solid ${t.gridline}">
           <strong>${esc(valueFmt(rows.reduce((sum, p) => sum + p.value[1], 0)))}</strong>
           <span style="opacity:.75">Total</span>
         </div>`
      : "";
    return `<div style="color:${t.textSecondary}">${esc(fmtStamp(params[0].value[0], res))}</div>` +
      tooltipRows(params, valueFmt) + total;
  };
  chart.setOption(opt, REPLACE);

  // Title: the day; sub: its totals and peak moment at this resolution.
  $("detail-title").textContent = fmtDay(day, DAY_FMT);
  const buckets = new Map();
  let usage = 0, cost = 0, hasCost = false;
  for (const entry of interval.series) {
    for (let i = 0; i < entry.starts.length; i++) {
      if (entry.starts[i].slice(0, 10) !== day || entry.values[i] == null) continue;
      usage += entry.values[i];
      buckets.set(entry.starts[i], (buckets.get(entry.starts[i]) ?? 0) + entry.values[i]);
      if (entry.costs && entry.costs[i] != null) { cost += entry.costs[i]; hasCost = true; }
    }
  }
  if (!buckets.size) {
    $("detail-sub").textContent = "no fine-grained data for this day";
  } else {
    let peak = null;
    for (const [s, v] of buckets) if (!peak || v > peak[1]) peak = [s, v];
    const resLabel = res === "quarter_hour" ? "15-minute" : "hourly";
    $("detail-sub").textContent =
      `${resLabel} · ${fmtNum(usage)} ${interval.unit}` +
      (hasCost ? ` · ${fmtUsd(cost)}` : "") +
      ` · peak ${new Date(peak[0]).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }

  const all = dayList();
  $("day-prev").disabled = all.indexOf(day) <= 0;
  $("day-next").disabled = all.indexOf(day) >= all.length - 1;
}

// --------------------------------------------------------------- side rail --

function renderCycleCard() {
  const win = currentWin();
  const rows = $("cycle-rows");
  rows.textContent = "";
  $("cycle-progress-track").hidden = true;
  $("cycle-progress-label").hidden = true;
  if (!win) {
    $("cycle-big").textContent = "–";
    $("cycle-sub").textContent = "";
    return;
  }
  const unit = intervalFor("daily")?.unit || "kWh";
  const row = (label, value, cls) => rows.insertAdjacentHTML("beforeend",
    `<div><dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ""}>${value}</dd></div>`);

  if (win.current) {
    const f = cycleFacts();
    if (!f) return;
    $("cycle-label").textContent = "Billing cycle";
    $("cycle-big").innerHTML = f.projCost != null
      ? `~${esc(fmtUsd(f.projCost, 0))}`
      : `~${esc(fmtNum(f.projUsage, 0))} <small>${esc(unit)}</small>`;
    $("cycle-sub").textContent = "projected";
    $("cycle-progress-track").hidden = false;
    $("cycle-progress").style.width =
      Math.min(100, (f.elapsed / f.cycleLen) * 100).toFixed(1) + "%";
    const progressLabel = $("cycle-progress-label");
    progressLabel.hidden = false;
    progressLabel.textContent = `${f.elapsed} of ~${f.cycleLen} days`;
    row("So far", `${fmtNum(f.usage, 0)} <small>${esc(unit)}</small>` +
      (f.cost != null ? ` · ${esc(fmtUsd(f.cost, 0))}` : ""));
    row("Days left", `~${f.daysLeft} <small>ends ~${esc(fmtDay(f.endEst))}</small>`);
    if (f.projUsage != null)
      row("Projected", `${fmtNum(f.projUsage, 0)} <small>${esc(unit)}</small>`);
    if (f.vsLastPct != null && Number.isFinite(f.vsLastPct)) {
      const over = f.vsLastPct > 0;
      row("vs last cycle",
        `${over ? "▲" : "▼"} ${Math.abs(f.vsLastPct).toFixed(0)}%`,
        over ? "bad" : "good");
    }
    const kw = alwaysOnEstimate();
    if (kw) row("Always-on", `${fmtNum(kw * 1000, 0)} <small>W</small>`);
  } else {
    // A past window: billed actuals.
    const days = windowDays(win);
    const usage = days.reduce((s, d) => s + d.value, 0);
    $("cycle-label").textContent = win.bill ? "Billed cycle" : "Month";
    $("cycle-big").innerHTML = win.bill
      ? esc(fmtUsd(win.bill.total_amount_usd))
      : `${esc(fmtNum(usage, 0))} <small>${esc(unit)}</small>`;
    $("cycle-sub").textContent = `${fmtDay(win.start)} – ${fmtDay(win.end)}`;
    if (win.bill) {
      row("Billed usage", `${fmtNum(win.bill.usage, 0)} <small>${esc(win.bill.unit)}</small>`);
      row("Effective rate", `${fmtUsd(win.bill.total_amount_usd / win.bill.usage, 2)}<small>/${esc(win.bill.unit)}</small>`);
      if (win.bill.estimated) row("Meter read", "estimated");
    }
    row("Metered", `${fmtNum(usage, 0)} <small>${esc(unit)}</small>`);
  }
}

function renderDevicesCard() {
  const card = $("devices-card");
  const win = currentWin();
  const comps = componentEntries("daily");
  card.hidden = !win || !comps.length;
  if (card.hidden) return;
  const t = tokens();
  const entries = [remainderEntry("daily", comps), ...comps].filter(Boolean);
  const rows = entries
    .map((entry) => {
      let value = 0, cost = 0, hasCost = false, any = false;
      for (let i = 0; i < entry.starts.length; i++) {
        const day = entry.starts[i].slice(0, 10);
        if (day < win.start || day > win.end || entry.values[i] == null) continue;
        any = true;
        value += entry.values[i];
        if (entry.costs && entry.costs[i] != null) { cost += entry.costs[i]; hasCost = true; }
      }
      return any ? { name: entry.name, value, cost: hasCost ? cost : null } : null;
    })
    .filter(Boolean);
  if (!rows.length) { card.hidden = true; return; }
  const hasCost = rows.some((r) => r.cost != null);
  const amount = (r) => (hasCost ? r.cost : r.value) ?? 0;
  rows.sort((a, b) => amount(b) - amount(a));
  const total = rows.reduce((s, r) => s + amount(r), 0);
  const unit = intervalFor("daily")?.unit || "kWh";

  $("devices-label").textContent =
    (hasCost ? "Cost by device · " : "Usage by device · ") + (win.current ? "this cycle" : "this window");
  $("devices-list").innerHTML = rows.map((r) =>
    `<li><span class="bk-dot" style="background:${slotColor(t, r.name)}"></span>` +
    `<span class="bk-name">${esc(r.name)}</span>` +
    `<span class="bk-share">${total > 0 ? `${((amount(r) / total) * 100).toFixed(0)}%` : ""}</span>` +
    `<span class="bk-value">${esc(hasCost ? fmtUsd(r.cost) : `${fmtNum(r.value)} ${unit}`)}</span></li>`,
  ).join("");
}

// Flags: one compact line each — date + short label left, the bold multiplier
// or wattage right; clicking puts the flagged day under the microscope. Long
// lists collapse to the newest five behind a "Show all" button.
const MAX_VISIBLE_FLAGS = 5;
let flagsExpanded = false;

function renderFlagsCard() {
  const flags = state.data.flags || [];
  const card = $("flags-card");
  card.hidden = !flags.length;
  if (!flags.length) return;
  const list = $("flags-list");
  list.textContent = "";
  const shown = flagsExpanded ? flags : flags.slice(0, MAX_VISIBLE_FLAGS);
  for (const flag of shown) {
    const overnight = flag.kind === "overnight_baseline";
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = flag.headline;

    const span = flag.end_date && flag.end_date !== flag.date;
    const endFmt = span && flag.end_date.slice(0, 7) === flag.date.slice(0, 7)
      ? { day: "numeric" } : undefined;
    const when = span ? `${fmtDay(flag.date)}–${fmtDay(flag.end_date, endFmt)}` : fmtDay(flag.date);
    const value = overnight
      ? `${fmtNum(flag.watts, 0)} W`
      : flag.typical_kwh
        ? `${(flag.kwh / flag.typical_kwh).toFixed(1)}×`
        : `${fmtNum(flag.kwh, 0)} kWh`;
    // The overnight kind keeps its detail sentence: the wattage alone doesn't
    // say what "typical" was.
    btn.innerHTML =
      `<span class="flag-line"><span class="flag-icon${overnight ? " overnight" : ""}">${overnight ? "●" : "⚑"}</span>` +
      `<span class="flag-head">${esc(`${when} · ${overnight ? "overnight load" : "high day"}`)}</span>` +
      `<span class="flag-value">${esc(value)}</span></span>` +
      (overnight && flag.detail ? `<span class="flag-detail">${esc(flag.detail)}</span>` : "");
    btn.addEventListener("click", () => {
      selectDay(flag.date);
      $("detail-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    li.append(btn);
    list.append(li);
  }
  const more = $("flags-more");
  more.hidden = flagsExpanded || flags.length <= MAX_VISIBLE_FLAGS;
  more.textContent = `Show all ${flags.length}`;
}

$("flags-more").addEventListener("click", () => {
  flagsExpanded = true;
  renderFlagsCard();
});

// --------------------------------------------------------------- selection --

function renderMain() {
  renderTagline();
  renderOverview();
  renderDetail();
  renderCycleCard();
  renderDevicesCard();
  renderFlagsCard();
  if (!$("overview-table").hidden) fillTable("overview");
  if (!$("detail-table").hidden) fillTable("detail");
}

// Put a day under the microscope, paging the overview to the cycle that
// contains it.
function selectDay(day) {
  if (!dayList().includes(day)) return;
  state.selectedDay = day;
  const idx = cycleWindows().findIndex((w) => day >= w.start && day <= w.end);
  if (idx >= 0) state.cycleIdx = idx;
  renderMain();
}

function shiftDay(delta) {
  const all = dayList();
  const i = all.indexOf(state.selectedDay) + delta;
  if (i >= 0 && i < all.length) selectDay(all[i]);
}

function shiftCycle(delta) { // +1 = older
  const wins = cycleWindows();
  const idx = state.cycleIdx + delta;
  if (idx < 0 || idx >= wins.length) return;
  state.cycleIdx = idx;
  const win = wins[idx];
  if (state.selectedDay < win.start || state.selectedDay > win.end) {
    const days = windowDays(win);
    state.selectedDay = days[days.length - 1]?.day ?? state.selectedDay;
  }
  renderMain();
}

$("day-prev").addEventListener("click", () => shiftDay(-1));
$("day-next").addEventListener("click", () => shiftDay(1));
$("cycle-prev").addEventListener("click", () => shiftCycle(1));
$("cycle-next").addEventListener("click", () => shiftCycle(-1));
document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, dialog")) return;
  if (event.key === "ArrowLeft") shiftDay(-1);
  else if (event.key === "ArrowRight") shiftDay(1);
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
  opt.series = series;
  opt.legend = legendFor(series, t);
  opt.grid.bottom = 36;
  opt.tooltip.formatter = (params) => {
    if (!params.length) return "";
    const period = new Date(params[0].axisValue + "T12:00:00")
      .toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return `<div style="color:${t.textSecondary}">Period ending ${esc(period)}</div>` +
      tooltipRows(params, valueFmt);
  };
  chart.setOption(opt, REPLACE);
  chart.resize();
}

function renderHistory() {
  const monthly = state.data.monthly;
  const hasMonthly = Array.isArray(monthly) && monthly.length > 0;
  $("monthly-usage-card").hidden = !hasMonthly;
  $("monthly-charge-card").hidden = !hasMonthly;
  if (hasMonthly) {
    const unit = monthly[0].unit || "";
    renderCategoryBars("monthly-usage-chart", monthly, "meter", "period_end", "usage",
      (x) => `${fmtNum(x)} ${unit}`, `Usage (${unit})`);
    renderCategoryBars("monthly-charge-chart", monthly, "meter", "period_end", "charge_usd",
      (x) => fmtUsd(x), "Charges ($)");
  }
  const bills = state.data.bills;
  const hasBills = Array.isArray(bills) && bills.length > 0;
  $("bills-card").hidden = !hasBills;
  if (hasBills) {
    renderCategoryBars("bills-chart", bills, "service_type", "period_end", "total_amount_usd",
      (x) => fmtUsd(x), "Total bill ($)");
  }
}

// History charts are only drawn while visible — echarts can't size a chart
// inside a hidden container.
$("history-btn").addEventListener("click", () => {
  const section = $("history");
  section.hidden = !section.hidden;
  $("history-btn").classList.toggle("active", !section.hidden);
  if (!section.hidden) {
    renderHistory();
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

// ------------------------------------------------------------- table views --

function buildTable(container, columns, rows) {
  const cell = (row, col) => esc(col.fmt ? col.fmt(row[col.key]) : row[col.key] ?? "–");
  container.innerHTML =
    `<table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) =>
      `<tr>${columns.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function fillTable(name) {
  if (name === "overview") {
    const win = currentWin();
    const unit = intervalFor("daily")?.unit ?? "";
    if (!win) return;
    buildTable($("overview-table"), [
      { key: "day", label: "Day", fmt: (v) => fmtDay(v, DAY_FMT) },
      { key: "value", label: `Usage (${unit})`, fmt: (v) => fmtNum(v, 2) },
      { key: "cost", label: "Cost ($)", fmt: (v) => fmtNum(v, 2) },
    ], windowDays(win).map((d) => ({ day: d.day, value: d.value, cost: d.hasCost ? d.cost : null })));
  } else if (name === "detail") {
    const res = detailRes();
    const interval = res && intervalFor(res);
    if (!interval || !state.selectedDay) return;
    const rows = [];
    for (const entry of interval.series) {
      for (let i = 0; i < entry.starts.length; i++) {
        if (entry.starts[i].slice(0, 10) !== state.selectedDay) continue;
        rows.push({
          start: entry.starts[i], stream: entry.name,
          value: entry.values[i],
          cost: !entry.costs || entry.costs[i] == null ? null : entry.costs[i],
        });
      }
    }
    rows.sort((a, b) => (a.start < b.start ? -1 : 1));
    buildTable($("detail-table"), [
      { key: "start", label: "Start", fmt: (v) => fmtStamp(new Date(v).getTime(), res) },
      { key: "stream", label: "Series" },
      { key: "value", label: `Usage (${interval.unit})`, fmt: (v) => fmtNum(v, 3) },
      { key: "cost", label: "Cost ($)", fmt: (v) => fmtNum(v, 3) },
    ], rows);
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

wireSeg("metric-seg", "metric", (value) => {
  localStorage.setItem("metric", value);
  state.metric = value;
  renderMain();
});
// Total mode folds every device in, so the chips go inert until it's left.
function syncChipState() {
  $("device-chips").classList.toggle("off", state.view === "total");
}

wireSeg("view-seg", "view", (value) => {
  localStorage.setItem("view", value);
  state.view = value;
  syncChipState();
  renderOverview();
  renderDetail();
});

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
    btn.innerHTML =
      `<span class="chip-dot" style="background:var(--series-${(paletteSlot(name) % 4) + 1})"></span>` +
      `<span>${esc(name)}</span>`;
    btn.title = `Break ${name} out of "Everything else"`;
    btn.classList.toggle("active", !state.folded.has(name));
    btn.addEventListener("click", () => {
      state.folded[state.folded.has(name) ? "delete" : "add"](name);
      localStorage.setItem("folded", JSON.stringify([...state.folded]));
      btn.classList.toggle("active", !state.folded.has(name));
      renderOverview();
      renderDetail();
    });
    root.append(btn);
  }
}

// ------------------------------------------------------------ data + jobs --

function renderAll() {
  if (!state.data) return;
  renderMain();
  if (!$("history").hidden) renderHistory();
}

async function loadData() {
  state.data = await getJson("/api/data");
  $("empty-note").hidden =
    state.data.intervals && Object.keys(state.data.intervals).length > 0;
  if (state.data.last_read) {
    const through = new Date(state.data.last_read);
    $("data-through").textContent =
      "Data through " + through.toLocaleString("en-US", TIME_FMT);
  } else {
    $("data-through").textContent = "";
  }
  checkFreshness();
  // Cost toggle only makes sense when a cost series exists.
  const anyCost = Object.values(state.data.intervals || {})
    .some((iv) => iv.series.some((s) => s.costs));
  $("metric-seg").hidden = !anyCost;
  if (!anyCost && state.metric === "cost") {
    state.metric = "usage";
    syncSeg("metric-seg", "metric", "usage");
  }
  // Default microscope target: the newest day (also after an update that
  // brought in newer days while the previous newest was selected).
  const all = dayList();
  if (all.length && (!state.selectedDay || !all.includes(state.selectedDay))) {
    state.selectedDay = all[all.length - 1];
    state.cycleIdx = 0;
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
      const job = await getJson("/api/job");
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
            localStorage.setItem("checkedAt", String(Date.now()));
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
  localStorage.setItem("lastUpdate", String(Date.now()));
  await fetch("/api/update", { method: "POST" });
  pollJob();
}

/* -------------------------------------------------------------- sign-in --- */

async function openLogin(error) {
  const session = await getJson("/api/session");
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
  await postJson("/api/login", body);
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
  await postJson("/api/mfa", { code });
});

// Reads post in ~4-hour blocks, so data over 4 hours old *might* have more
// behind it: pull (cheap, often empty), at most once per RECHECK_MS. A
// successful pull — even an empty one — clears the badge for that long.
const STALE_MS = 4 * 3600e3;
const RECHECK_MS = 30 * 60e3;

function checkFreshness() {
  const last = state.data?.last_read;
  const stale = !last || Date.now() - new Date(last).getTime() > STALE_MS;
  const since = (key) => Date.now() - Number(localStorage.getItem(key) || 0);
  $("stale-badge").hidden = !stale || since("checkedAt") < RECHECK_MS;
  if (stale && !polling && since("lastUpdate") >= RECHECK_MS) startUpdate();
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
  const job = await getJson("/api/job");
  if (job.running) pollJob();
  else checkFreshness();
  setInterval(checkFreshness, 60e3);
}

init();
