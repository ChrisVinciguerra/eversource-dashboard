/* Eversource energy dashboard — the billing cycle on a calendar.
   The cycle is a month grid, one cell per day, with its closing day marked;
   beside it, when the bill closes, where it will land, and the running total
   against the previous cycle. Picking a day opens it underneath at 15-minute
   or hourly resolution, one line per known device.
   Data comes from /api/data; long operations (update, sign-in) run as
   server-side jobs polled via /api/job. */

"use strict";

const $ = (id) => document.getElementById(id);

// The picks survive reloads.
const savedView = localStorage.getItem("dayView");
const state = {
  data: null,
  metric: localStorage.getItem("metric") || "usage", // usage | cost
  // The day chart: known devices as separate "lines" (default) or "stacked"
  // bars, or "total": the one metered series with every device folded in.
  view: savedView === "stacked" || savedView === "total" ? savedView : "lines",
  // Known devices left inside "Everything else" instead of broken out.
  folded: new Set(JSON.parse(localStorage.getItem("folded") || "[]")),
  cycleIdx: 0,        // 0 = newest window (the running cycle)
  selectedDay: null,  // "YYYY-MM-DD" shown in the day chart
  // Preferred resolution of the day chart; falls back to whatever exists.
  detailRes: localStorage.getItem("detailRes") || "quarter_hour",
};

const charts = {};        // id -> echarts instance

// ------------------------------------------------------------------ theme --

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () =>
  (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  $("theme-btn").textContent = isDark() ? "Light" : "Dark";
}
applyTheme(localStorage.getItem("theme"));

$("theme-btn").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
  renderAll();
});
darkQuery.addEventListener("change", () => { applyTheme(); renderAll(); });

// The CSS tokens, resolved for the canvas: each is a light-dark(a, b) pair.
function tokens() {
  const css = getComputedStyle(document.documentElement);
  const dark = isDark();
  const v = (name) => {
    const raw = css.getPropertyValue(name).trim();
    const pair = /^light-dark\((\S+),\s*(\S+)\)$/.exec(raw);
    return pair ? pair[dark ? 2 : 1] : raw;
  };
  return {
    page: v("--page"), ink: v("--ink"), text2: v("--text-2"), muted: v("--muted"),
    rule: v("--rule"), ruleStrong: v("--rule-strong"), tint: v("--tint"),
    meter: v("--meter"), ref: v("--ref"), flag: v("--flag"),
    devices: [v("--dev-1"), v("--dev-2"), v("--dev-3"), v("--dev-4")],
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

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
let still = false;   // set while re-rendering for a resize: no transitions
const PLOT = { left: 44, right: 10 };   // the day chart's side insets

const round = (x, unit = 1e6) => (x == null ? null : Math.round(x * unit) / unit);
const axisText = (t) => ({ color: t.muted, fontSize: 11 });
const moneyTick = (v) => "$" + (v >= 1 || v === 0 ? fmtNum(v, 0) : round(v, 1e3));

function chartBase(t) {
  return {
    textStyle: { fontFamily: FONT },
    animation: !still,
    animationDuration: 200,
    animationDurationUpdate: 200,
    tooltip: {
      trigger: "axis",
      backgroundColor: t.page,
      borderColor: t.ruleStrong,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: t.ink, fontSize: 12.5 },
      extraCssText: "box-shadow:none;border-radius:4px;font-variant-numeric:tabular-nums;",
    },
  };
}

function valueAxis(t, extra) {
  return {
    type: "value",
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: axisText(t),
    splitLine: { lineStyle: { color: t.rule } },
    nameTextStyle: { ...axisText(t), align: "right", padding: [0, 8, 0, 0] },
    nameGap: 8,
    ...extra,
  };
}

// Tooltip pieces: a muted heading, then "swatch value name" rows.
const tipHead = (t, text) => `<div style="color:${t.text2}">${esc(text)}</div>`;
const tipRow = (color, value, name) =>
  `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
     <span style="width:8px;height:8px;background:${color || "transparent"};flex:none"></span>
     <strong>${esc(value)}</strong><span style="opacity:.7">${esc(name)}</span>
   </div>`;

// Reuse the instance across renders: updates morph in place instead of
// replaying the entry animation.
function makeChart(id) {
  if (!charts[id]) charts[id] = echarts.init($(id), null, { renderer: "canvas" });
  return charts[id];
}

// Axes and series are rebuilt wholesale each render, so stale pieces (an
// axis formatter, a removed series) don't linger through option merging.
const REPLACE = { replaceMerge: ["xAxis", "yAxis", "series"] };
window.addEventListener("resize", () => {
  Object.values(charts).forEach((c) => c.resize());
  still = true;
  renderMain();   // label density follows the width
  still = false;
});

// ------------------------------------------------------------ data shapes --

function intervalFor(res) {
  return state.data && state.data.intervals ? state.data.intervals[res] : null;
}

// The sub-daily dataset for the day-under-the-microscope chart: the picked
// resolution when it exists, else the finest available.
const DETAIL_RESES = ["quarter_hour", "hourly"];
const detailRes = () =>
  [state.detailRes, ...DETAIL_RESES].find((r) => DETAIL_RESES.includes(r) && intervalFor(r)) || null;

// Known-device names in a stable order: device i always takes color i.
function deviceNames() {
  return [...new Set(
    Object.values(state.data.intervals || {})
      .flatMap((iv) => iv.devices || [])
      .map((dev) => dev.name),
  )];
}


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


// A device's color; the meter color for everything that isn't a known device
// ("Everything else", or the plain metered series).
const seriesColor = (t, name) => {
  const i = deviceNames().indexOf(name);
  return i < 0 ? t.meter : t.devices[i % t.devices.length];
};
const cssColor = (name) => {
  const i = deviceNames().indexOf(name);
  return i < 0 ? "var(--meter)" : `var(--dev-${(i % 4) + 1})`;
};

// The split of the meter the current view asks for, in stacking order: each
// unfolded device, then "Everything else" on top. Total mode (or no known
// devices) is the plain metered series.
function viewEntries(res) {
  const interval = intervalFor(res);
  if (!interval) return { entries: [], split: false };
  const comps = state.view === "total" ? [] : componentEntries(res);
  if (!comps.length) return { entries: interval.series, split: false };
  const shown = comps.filter((dev) => !state.folded.has(dev.name));
  return { entries: [...shown, remainderEntry(res, shown)].filter(Boolean), split: true };
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

// How much of `day` the meter data actually covers, as a 0..1 fraction: the
// end of the last sub-daily read on it. Data usually stops partway through
// the newest day, and pacing that as a full day drags the projection down.
// 1 when no sub-daily data reaches the day (nothing to judge it by).
function dayCoverage(day) {
  let frac = 0;
  for (const [res, hours] of [["quarter_hour", 0.25], ["hourly", 1]]) {
    for (const entry of intervalFor(res)?.series || []) {
      for (let i = entry.starts.length - 1; i >= 0; i--) {
        const start = entry.starts[i];
        if (entry.values[i] == null) continue;
        if (start.slice(0, 10) === day) {
          const end = +start.slice(11, 13) + +start.slice(14, 16) / 60 + hours;
          frac = Math.max(frac, Math.min(1, end / 24));
        }
        break; // only the newest read matters
      }
    }
  }
  return frac || 1;
}

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
  // Pace over the time the data really spans: the newest day counts only as
  // far as its reads go, not as a whole day.
  const paced = elapsed - 1 + dayCoverage(days[days.length - 1].day);
  const projUsage = paced > 0 ? (usage / paced) * cycleLen : null;
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


// --------------------------------------------------------------- calendar --
// The billing cycle as a month grid: week rows, weekday columns, real dates.
// Each day of the cycle carries its amount in the measure on show and is
// shaded by it; the first and the closing day are named; days outside the
// cycle are bare dates. A day with reads is a button that opens it below.

const flagsOn = (day) =>
  (state.data.flags || []).filter((f) => f.date <= day && day <= (f.end_date || f.date));
const pad2 = (n) => String(n).padStart(2, "0");
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function renderCalendar(win, facts) {
  const cost = state.metric === "cost";
  const unit = intervalFor("daily").unit;
  const amount = (d) => (cost ? (d.hasCost ? d.cost : null) : d.value);
  const days = new Map(windowDays(win).map((d) => [d.day, d]));
  // A billed cycle ends exactly; the running one on its estimated closing day.
  const end = facts && facts.endEst > win.end ? facts.endEst : win.end;
  const newest = dayList().at(-1);
  const covered = dayCoverage(newest) * 24;
  const partial = win.current && covered < 24 ? newest : null;
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  // Shading is relative to the cycle's own typical day and saturates at 2.5×
  // it, so one extreme day doesn't wash out the difference between the rest.
  const full = 2.5 * median([...days.values()]
    .filter((d) => d.day !== partial).map(amount).filter((v) => v != null));
  const first = addDays(win.start, -dayDate(win.start).getDay());
  const count = Math.ceil((daysBetween(first, end) + 1) / 7) * 7;

  let html = "";
  for (let i = 0; i < count; i++) {
    const day = addDays(first, i);
    const dom = +day.slice(8);
    const date = `<span class="d-date">${i === 0 || dom === 1 ? esc(fmtDay(day)) : dom}</span>`;
    if (day < win.start || day > end) {
      html += `<div class="day out">${date}</div>`;
      continue;
    }
    const d = days.get(day);
    const v = d ? amount(d) : null;
    const flags = flagsOn(day);
    const cls = ["day", d ? "has" : "open"];
    if (day === today) cls.push("today");
    if (day === state.selectedDay) cls.push("sel");
    if (day === end) cls.push("end", end > win.end ? "est" : "");
    if (flags.length) {
      cls.push("flag");
      if (flags.some((f) => f.date === day)) cls.push("flag-a");
      if (flags.some((f) => (f.end_date || f.date) === day)) cls.push("flag-z");
    }
    // One note per cell: the cycle's ends, else how far today's reads go.
    const mark = day === end ? `<i>bill </i>${end > win.end ? "closes" : "closed"}`
      : day === win.start ? "day 1"
      : day === partial ? `<i>to </i>${esc(clockLabel(`${pad2(Math.floor(covered))}:${pad2(Math.round((covered % 1) * 60))}`))}` : "";
    const body = date + (mark ? `<span class="d-mark">${mark}</span>` : "") +
      (d ? `<span class="d-val">${v == null ? "–" : esc(cost ? fmtUsd(v) : fmtNum(v, 1))}</span>` : "");
    if (!d) {
      html += `<div class="${cls.join(" ")}">${body}</div>`;
      continue;
    }
    const title = `${fmtDay(day, DAY_FMT)}: ${fmtNum(d.value)} ${unit}` +
      (d.hasCost ? `, ${fmtUsd(d.cost)}` : "") + flags.map((f) => `\n${f.headline}`).join("");
    const heat = v != null && full > 0 ? Math.min(1, Math.max(0, v / full)) : 0;
    html += `<button type="button" class="${cls.join(" ")}" data-day="${day}" style="--h:${heat.toFixed(3)}"` +
      ` aria-pressed="${day === state.selectedDay}" title="${esc(title)}">${body}</button>`;
  }
  $("cal-grid").innerHTML = html;
  $("cal-note").textContent = full > 0
    ? `${cost ? "Cost" : unit} per day. Darker is heavier, darkest at ` +
      `${cost ? fmtUsd(full, full < 10 ? 2 : 0) : `${fmtNum(full, 0)} ${unit}`} and up.`
    : "";
}

$("cal-grid").addEventListener("click", (event) => {
  const cell = event.target.closest("button[data-day]");
  if (cell) selectDay(cell.dataset.day);
});

// ------------------------------------------------------------------ trend --
// The cycle's running total as a line, projected to its closing day, against
// the previous cycle's line. The x-axis runs to the cycle's end, so how far
// in we are is a position.

function renderTrend(win, facts) {
  const t = tokens();
  const chart = makeChart("trend-chart");
  const unit = intervalFor("daily").unit;
  const cost = state.metric === "cost";
  const amount = (d) => (cost ? (d.hasCost ? d.cost : null) : d.value);
  const fmtAmount = cost ? (x) => fmtUsd(x) : (x) => `${fmtNum(x)} ${unit}`;

  const mine = windowDays(win);
  const prev = cycleWindows()[state.cycleIdx + 1] || null;
  const theirs = prev ? windowDays(prev) : [];
  const prevLen = prev ? daysBetween(prev.start, prev.end) + 1 : 0;
  // The previous cycle is only a fair reference when its days are all there.
  const hasPrev = theirs.length > 0 && theirs.length >= prevLen - 1;
  const ownLen = Math.max(facts ? facts.cycleLen : 0, daysBetween(win.start, win.end) + 1);
  const n = Math.max(ownLen, hasPrev ? prevLen : 0);
  const axis = Array.from({ length: n }, (_, i) => addDays(win.start, i));

  // Running totals by day-of-cycle.
  const running = (days, start) => {
    const out = new Array(n).fill(null);
    let sum = 0;
    for (const d of days) {
      if (amount(d) == null) continue;
      sum += amount(d);
      out[daysBetween(start, d.day)] = round(sum, 1e3);
    }
    return out;
  };
  const cum = running(mine, win.start);
  const ref = hasPrev ? running(theirs, prev.start) : null;
  const tip = daysBetween(win.start, mine[mine.length - 1].day);
  const projected = facts ? (cost ? facts.projCost : facts.projUsage) : null;
  const endIdx = facts ? facts.cycleLen - 1 : tip;

  const series = [];
  const line = (id, data, color, extra) => series.push({
    id, type: "line", data, connectNulls: true, showSymbol: false, silent: true,
    lineStyle: { color, width: 2 }, itemStyle: { color }, ...extra,
  });
  const note = (i, value, text, extra) => ({
    silent: true, symbol: "circle", symbolSize: 7,
    data: [{ coord: [i, value] }],
    label: { show: !!text, color: t.text2, fontSize: 12, formatter: () => text,
             rich: { b: { color: t.ink, fontWeight: 600, fontSize: 12.5 } }, ...extra },
  });
  if (ref) {
    const last = ref.findLastIndex((v) => v != null);
    line("ref", ref, t.ref, {
      lineStyle: { color: t.ref, width: 1.5 },
      markPoint: {
        ...note(last, ref[last], win.current ? "last cycle" : "cycle before",
          // above its line's end, or below when this cycle's line runs over it
          { position: "left", offset: [4, ref[last] >= (projected ?? cum[tip]) ? -11 : 20],
            color: t.muted, fontSize: 11.5 }),
        symbolSize: 0,
      },
    });
  }
  if (projected != null && endIdx > tip) {
    const data = new Array(n).fill(null);
    data[tip] = { value: cum[tip], symbol: "none" };
    data[endIdx] = {
      value: round(projected, 1e3), symbol: "circle", symbolSize: 7,
      itemStyle: { color: t.page, borderColor: t.ink, borderWidth: 1.5 },
    };
    line("projection", data, t.ink, {
      showSymbol: true,
      lineStyle: { color: t.ink, width: 1.5, type: [3, 4], opacity: 0.6 },
    });
  }
  // The tip of the running total carries the so-far figures.
  const late = tip > n * 0.62;
  line("pace", cum, t.ink, {
    z: 3,
    markPoint: {
      ...note(tip, cum[tip], facts
        ? `{b|${fmtNum(facts.usage, 0)} ${unit}${facts.cost != null ? ` · ${fmtUsd(facts.cost, 0)}` : ""}} so far` : "",
        { position: late ? "left" : "right", offset: late ? [-2, -13] : [2, 13] }),
      itemStyle: { color: t.ink, borderColor: t.page, borderWidth: 1.5 },
    },
    // The selected day, as a hairline.
    markLine: axis.includes(state.selectedDay) ? {
      silent: true, symbol: "none", label: { show: false },
      lineStyle: { color: t.ruleStrong, width: 1, type: "solid" },
      data: [{ xAxis: state.selectedDay }],
    } : undefined,
  });

  chart.setOption({
    ...chartBase(t),
    grid: { left: 40, right: 12, top: 20, bottom: 24 },
    xAxis: {
      type: "category", data: axis, boundaryGap: false,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: t.ruleStrong } },
      axisPointer: { label: { show: false }, lineStyle: { color: t.ruleStrong, type: "solid" } },
      axisLabel: {
        ...axisText(t),
        interval: (i) => i % 7 === 0,
        formatter: (day, i) => (i === 0 || +day.slice(8) <= 7 ? fmtDay(day) : String(+day.slice(8))),
      },
    },
    yAxis: valueAxis(t, {
      splitNumber: 3, name: cost ? "" : unit,
      axisLabel: { ...axisText(t), formatter: cost ? moneyTick : undefined },
    }),
    series,
    tooltip: {
      ...chartBase(t).tooltip,
      formatter: (params) => {
        if (!params.length) return "";
        const i = params[0].dataIndex;
        return tipHead(t, `${fmtDay(axis[i], DAY_FMT)} · day ${i + 1}`) +
          (cum[i] != null ? tipRow(t.ink, fmtAmount(cum[i]), "into this cycle") : "") +
          (ref && ref[i] != null ? tipRow(t.ref, fmtAmount(ref[i]), "the cycle before, same day") : "");
      },
    },
  }, REPLACE);
}

// The cycle in words: when it closes and how long is left, where the bill
// lands (projected for the running cycle, billed for a finished one), and
// how that compares with the cycle before.
function renderReadout(win, facts, prev) {
  const unit = intervalFor("daily").unit;
  const long = { weekday: "short", month: "short", day: "numeric" };
  const len = daysBetween(win.start, win.end) + 1;
  $("cycle-title").textContent = win.current ? "This cycle" : `${fmtDay(win.start)} – ${fmtDay(win.end)}`;
  $("cycle-sub").textContent = facts ? `${fmtDay(win.start)} – ${fmtDay(facts.endEst)}` : win.bill ? "billed" : "";
  const wins = cycleWindows();
  $("cycle-prev").disabled = state.cycleIdx >= wins.length - 1;
  $("cycle-next").disabled = state.cycleIdx <= 0;

  const due = facts && facts.daysLeft > 0;
  $("closes").innerHTML = due ? `Closes about <b>${esc(fmtDay(facts.endEst, long))}</b>`
    : facts ? "Due to close <b>any day now</b>"
    : `Closed <b>${esc(fmtDay(win.end, { ...long, year: "numeric" }))}</b>`;
  $("closes-sub").textContent = due
    ? `${facts.daysLeft} ${facts.daysLeft === 1 ? "day" : "days"} left · day ${facts.elapsed} of about ${facts.cycleLen}`
    : facts ? `day ${facts.elapsed} · cycles usually run about ${facts.cycleLen}`
    : `${len} days`;

  const big = $("land-big"), delta = $("land-delta"), refEl = $("land-ref");
  let vs = null;
  if (facts) {
    big.innerHTML = facts.projCost != null
      ? `~${esc(fmtUsd(facts.projCost, 0))}`
      : `~${esc(fmtNum(facts.projUsage, 0))} <small>${esc(unit)}</small>`;
    $("land-line").textContent = facts.projCost != null
      ? `projected bill · ~${fmtNum(facts.projUsage, 0)} ${unit}` : "projected";
    vs = facts.vsLastPct;
  } else if (win.bill) {
    const b = win.bill;
    big.textContent = fmtUsd(b.total_amount_usd);
    $("land-line").textContent = `billed · ${fmtNum(b.usage, 0)} ${b.unit}` +
      (b.estimated ? " (estimated read)" : "") + ` · ${fmtUsd(b.total_amount_usd / b.usage)}/${b.unit}`;
    if (prev && prev.bill) vs = ((b.usage - prev.bill.usage) / prev.bill.usage) * 100;
  } else {
    const metered = windowDays(win).reduce((sum, d) => sum + d.value, 0);
    big.innerHTML = `${esc(fmtNum(metered, 0))} <small>${esc(unit)}</small>`;
    $("land-line").textContent = "metered";
  }
  const shown = vs != null && Number.isFinite(vs);
  const which = win.current ? "last bill" : "the bill before";
  delta.className = "land-delta " + (shown ? (vs > 0 ? "bad" : "good") : "");
  delta.textContent = shown ? `${Math.abs(vs).toFixed(0)}% ${vs > 0 ? "over" : "under"} ${which}` : "";
  refEl.hidden = !(prev && prev.bill);
  if (prev && prev.bill) {
    refEl.textContent = (shown ? "" : which + " ") +
      `${fmtUsd(prev.bill.total_amount_usd)} · ${fmtNum(prev.bill.usage, 0)} ${prev.bill.unit}`;
  }
}

// ------------------------------------------------------------- device key --
// The day chart's legend, and the split across known devices for the day on
// show and for the whole cycle. Each known device is also its own toggle:
// off folds it back into "Everything else".

function renderKey() {
  const key = $("device-key");
  const win = currentWin();
  const comps = componentEntries("daily");
  key.hidden = !comps.length;
  $("view-seg").hidden = !comps.length;
  if (key.hidden) return;
  const total = state.view === "total";
  key.classList.toggle("total-only", total);
  const shown = total ? comps : comps.filter((dev) => !state.folded.has(dev.name));
  const cost = state.metric === "cost" && comps.some((dev) => dev.costs);
  const rows = [remainderEntry("daily", shown), ...shown].filter(Boolean).map((entry) => {
    const ys = (cost ? entry.costs : entry.values) || [];
    let sum = 0, day = null;
    for (let i = 0; i < entry.starts.length; i++) {
      const at = entry.starts[i].slice(0, 10);
      if (ys[i] == null) continue;
      if (at >= win.start && at <= win.end) sum += ys[i];
      if (at === state.selectedDay) day = ys[i];
    }
    return { name: entry.name, sum, day };
  }).sort((a, b) => b.sum - a.sum);
  const all = rows.reduce((s, r) => s + r.sum, 0);
  const folded = total ? [] : comps.filter((dev) => state.folded.has(dev.name));
  const words = (x, big) => (x == null ? "–" : cost ? fmtUsd(x) : fmtNum(x, big && x >= 10 ? 0 : 1));

  const row = (name, r) => {
    const device = name !== "Everything else" && !total;
    const cells =
      `<span class="key-swatch" style="--c:${cssColor(name)}"></span>` +
      `<span class="key-name">${esc(name)}</span>` +
      (!r ? "<span></span><span></span><span></span>"
        : `<span class="key-amt">${esc(words(r.day))}</span>` +
          `<span class="key-cyc">${esc(words(r.sum, true))}</span>` +
          `<span class="key-share">${all > 0 ? ((r.sum / all) * 100).toFixed(0) + "%" : ""}</span>`);
    return device
      ? `<li><button type="button" class="key-row${r ? "" : " folded"}" data-name="${esc(name)}"` +
        ` aria-pressed="${!!r}" title="${r ? "Fold into Everything else" : "Break out"}">${cells}</button></li>`
      : `<li><div class="key-row">${cells}</div></li>`;
  };
  $("key-list").innerHTML =
    `<li><div class="key-row key-head"><span></span><span>${cost ? "cost" : esc(intervalFor("daily").unit)}</span>` +
    `<span>${esc(fmtDay(state.selectedDay))}</span><span>cycle</span><span></span></div></li>` +
    rows.map((r) => row(r.name, r)).join("") + folded.map((dev) => row(dev.name, null)).join("");
}

$("key-list").addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  const name = btn.dataset.name;
  state.folded[state.folded.has(name) ? "delete" : "add"](name);
  localStorage.setItem("folded", JSON.stringify([...state.folded]));
  renderMain();
});

// -------------------------------------------------------------- day chart --

// The day chart's y range. One range for the whole cycle keeps days
// comparable but leaves a quiet day as a strip along the bottom (one space
// heater sets the scale for a month). So the axis sits on a 1-2-5 ladder:
// the rung that fits the cycle's typical daily peak is the usual scale, and a
// day moves off it only as far as it must — up for a heavy day, down (two
// rungs at most) for a quiet one. `zoom` says how far: 1 on the usual scale.
const RUNGS = [1, 2, 5];
const rungValue = (r) => RUNGS[((r % 3) + 3) % 3] * 10 ** Math.floor(r / 3);
function rungFor(x) {
  let r = Math.floor(Math.log10(x)) * 3;
  while (rungValue(r) < x - 1e-12) r++;
  return r;
}

function detailYExtent(entries, metric, stacked, win, day) {
  const peaks = new Map();   // day -> its highest bucket (or stack)
  let lo = 0;
  const see = (start, v) => {
    const at = start.slice(0, 10);
    if (at !== day && (at < win.start || at > win.end)) return;
    if (v > (peaks.get(at) ?? 0)) peaks.set(at, v);
    if (at === day && v < lo) lo = v;
  };
  const sums = new Map();
  for (const entry of entries) {
    const ys = metric === "cost" ? entry.costs : entry.values;
    if (!ys) continue;
    for (let i = 0; i < ys.length; i++) {
      if (ys[i] == null) continue;
      if (stacked) sums.set(entry.starts[i], (sums.get(entry.starts[i]) ?? 0) + ys[i]);
      else see(entry.starts[i], ys[i]);
    }
  }
  for (const [start, v] of sums) see(start, v);
  const typical = median([...peaks.values()]);
  if (!(typical > 0)) return null;
  const usual = rungFor(typical);
  const rung = Math.max(usual - 2, rungFor(peaks.get(day) || typical));
  const max = rungValue(rung);
  const interval = max / (RUNGS[((rung % 3) + 3) % 3] === 2 ? 4 : 5);
  // Slightly negative buckets are breakdown noise (device estimates
  // overshooting the meter), not worth a negative axis; real export is.
  const min = lo < -0.1 * max ? -Math.ceil(-lo / interval) * interval : 0;
  return { min: round(min, 1e9), max: round(max, 1e9), interval: round(interval, 1e9),
           zoom: rungValue(usual) / max };
}


const clockLabel = (hhmm) => {
  const h = +hhmm.slice(0, 2), m = hhmm.slice(3);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "AM" : "PM"}`;
};

// The selected day, slot by slot: a line per device (and one for everything
// else), or the same split as stacked bars, or the meter's one line.
function renderDay() {
  const res = detailRes();
  const day = state.selectedDay;
  $("res-seg").hidden = DETAIL_RESES.some((r) => !intervalFor(r));
  syncTabs("res-seg", "res", res);
  $("day-band").hidden = !res || !day;
  if (!res || !day) return;
  const t = tokens();
  const chart = makeChart("day-chart");
  const interval = intervalFor(res);
  const cost = state.metric === "cost";
  const valueFmt = cost ? (x) => fmtUsd(x, 3) : (x) => `${fmtNum(x)} ${interval.unit}`;

  // Slots are wall-clock positions in the day, so a partial day keeps its
  // empty remainder and every day shares one axis.
  const step = res === "quarter_hour" ? 15 : 60;
  const count = 1440 / step;
  const slotOf = (start) => (+start.slice(11, 13) * 60 + +start.slice(14, 16)) / step;
  const labels = Array.from({ length: count }, (_, i) =>
    `${String(Math.floor((i * step) / 60)).padStart(2, "0")}:${String((i * step) % 60).padStart(2, "0")}`);
  const slotted = (entry, ys) => {
    const data = new Array(count).fill(null);
    for (let i = 0; i < entry.starts.length; i++) {
      if (ys[i] == null || !entry.starts[i].startsWith(day)) continue;
      const k = slotOf(entry.starts[i]);
      data[k] = round((data[k] ?? 0) + ys[i]);
    }
    return data;
  };

  const { entries, split } = viewEntries(res);
  const bars = split && state.view === "stacked";
  const series = entries
    .filter((entry) => (cost ? entry.costs : entry.values))
    .map((entry) => {
      const color = seriesColor(t, entry.name);
      const data = slotted(entry, cost ? entry.costs : entry.values);
      return bars
        ? { name: entry.name, type: "bar", stack: "day", data, barCategoryGap: "18%",
            itemStyle: { color }, emphasis: { disabled: true } }
        : { name: entry.name, type: "line", data, showSymbol: false,
            lineStyle: { color, width: 2 }, itemStyle: { color },
            emphasis: { disabled: true }, z: color === t.meter ? 2 : 3,
            areaStyle: split ? undefined : { color, opacity: 0.08 } };
    });

  // The day's metered totals, for the header and the latest-read marker.
  const usage = new Array(count).fill(null);
  let costSum = null;
  for (const entry of interval.series) {
    slotted(entry, entry.values).forEach((v, k) => { if (v != null) usage[k] = (usage[k] ?? 0) + v; });
    if (entry.costs) {
      for (const v of slotted(entry, entry.costs)) if (v != null) costSum = (costSum ?? 0) + v;
    }
  }
  const filled = usage.findLastIndex((v) => v != null) + 1;
  if (series.length && filled && filled < count && day === dayList().at(-1)) {
    series[0].markLine = {
      silent: true, symbol: "none",
      lineStyle: { color: t.ruleStrong, width: 1, type: "dashed" },
      label: { formatter: "latest read", color: t.muted, fontSize: 10.5, position: "end", distance: 4 },
      data: [{ xAxis: filled }],
    };
  }

  const extent = detailYExtent(entries, state.metric, bars, currentWin(), day);
  const every = (chart.getWidth() < 560 ? 6 : 3) * (60 / step);

  chart.setOption({
    ...chartBase(t),
    grid: { left: PLOT.left, right: PLOT.right, top: 26, bottom: 30 },
    xAxis: {
      type: "category", data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: t.ruleStrong } },
      axisLabel: { ...axisText(t), interval: (i) => i % every === 0, formatter: clockLabel },
      axisPointer: bars ? { type: "shadow", shadowStyle: { color: t.tint } }
        : { type: "line", lineStyle: { color: t.ruleStrong, type: "solid" } },
    },
    yAxis: valueAxis(t, {
      ...(extent ? { min: extent.min, max: extent.max, interval: extent.interval } : {}),
      name: cost ? "" : interval.unit,
      axisLabel: { ...axisText(t), formatter: cost ? moneyTick : undefined },
    }),
    series,
    tooltip: {
      ...chartBase(t).tooltip,
      formatter: (params) => {
        const rows = params.filter((p) => p.value != null);
        if (!rows.length) return "";
        const total = rows.reduce((sum, p) => sum + p.value, 0);
        return tipHead(t, clockLabel(params[0].axisValue)) +
          (split ? `<div><strong>${esc(valueFmt(total))}</strong></div>` : "") +
          rows.reverse().map((p) => tipRow(p.color, valueFmt(p.value), p.seriesName)).join("");
      },
    },
  }, REPLACE);

  $("day-title").textContent = fmtDay(day, { weekday: "long", month: "long", day: "numeric" });
  // The day's reading, in words beside its title; and a note whenever the
  // axis is off the cycle's usual scale, so heights aren't misread.
  if (!filled) {
    $("day-read").textContent = "No fine-grained reads for this day.";
  } else {
    const peak = usage.indexOf(Math.max(...usage.filter((v) => v != null)));
    const zoom = extent ? extent.zoom : 1;
    $("day-read").textContent = [
      `${fmtNum(usage.reduce((s, v) => s + (v ?? 0), 0))} ${interval.unit}`,
      costSum != null ? fmtUsd(costSum) : "",
      `peak at ${clockLabel(labels[peak])}`,
      filled < count ? `read to ${clockLabel(labels[filled] ?? "24:00")}` : "",
      zoom > 1 ? `quiet day: axis zoomed in ${round(zoom, 10)}×`
        : zoom < 1 ? `heavy day: axis zoomed out ${round(1 / zoom, 10)}×` : "",
    ].filter(Boolean).join(" · ");
  }
  const all = dayList();
  $("day-prev").disabled = all.indexOf(day) <= 0;
  $("day-next").disabled = all.indexOf(day) >= all.length - 1;
}

// ------------------------------------------------------------------ flags --
// Usually there are none, and then there is nothing here. Each flag is a
// footnote to the calendar, worded by the server, in the red that marks its
// days on the grid; clicking one opens the day it starts on.

function renderFlags() {
  $("flags-list").innerHTML = (state.data.flags || []).map((flag, i) =>
    `<li><button type="button" data-i="${i}">` +
    `<span class="flag-head">${esc(flag.headline)}</span>` +
    (flag.value ? `<span class="flag-value">${esc(flag.value)}</span>` : "") +
    (flag.detail ? `<span class="flag-detail">${esc(flag.detail)}</span>` : "") +
    `</button></li>`).join("");
}

$("flags-list").addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  selectDay(state.data.flags[btn.dataset.i].date);
  $("day-band").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// --------------------------------------------------------------- selection --

function renderMain() {
  const win = state.data && currentWin();
  $("cycle").hidden = !win;
  if (!win) { $("day-band").hidden = true; return; }
  const facts = win.current ? cycleFacts() : null;
  renderCalendar(win, facts);
  renderReadout(win, facts, cycleWindows()[state.cycleIdx + 1] || null);
  renderTrend(win, facts);
  renderDay();
  renderKey();
  renderFlags();
  for (const name of ["cycle", "day"]) if (!$(name + "-table").hidden) fillTable(name);
}

// Open a day, paging the calendar to the cycle that contains it.
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

// ---------------------------------------------------------------- history --
// One bar per bill, in the measure on show, each with its value written on
// it. A bill opens its cycle on the calendar when the reads go back that far.

const monthLabel = (iso) => `${fmtDay(iso, { month: "short" })} ’${iso.slice(2, 4)}`;

function renderHistory() {
  const bills = state.data.bills || [];
  const t = tokens();
  const chart = makeChart("bills-chart");
  const cost = state.metric === "cost";
  const words = (b, digits) => (cost ? fmtUsd(b.total_amount_usd, digits) : `${fmtNum(b.usage, digits)} ${b.unit}`);
  const periods = [...new Set(bills.map((b) => b.period_end))].sort();
  const services = [...new Set(bills.map((b) => b.service_type))];
  const series = services.map((name, s) => {
    const mine = new Map(bills.filter((b) => b.service_type === name).map((b) => [b.period_end, b]));
    return {
      name, type: "bar", barMaxWidth: 30, emphasis: { disabled: true },
      itemStyle: { color: services.length > 1 ? t.devices[s % t.devices.length] : t.meter },
      label: { show: true, position: "top", color: t.text2, fontSize: 11,
               formatter: (p) => (p.data && p.data.bill ? words(p.data.bill, 0) : "") },
      data: periods.map((p) => {
        const bill = mine.get(p);
        return bill ? { value: cost ? bill.total_amount_usd : bill.usage, bill } : null;
      }),
    };
  });
  chart.setOption({
    ...chartBase(t),
    grid: { left: 12, right: 12, top: services.length > 1 ? 46 : 24, bottom: 24 },
    legend: services.length > 1 ? { top: 0, left: 0, textStyle: { color: t.text2 } } : { show: false },
    xAxis: {
      type: "category", data: periods,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: t.ruleStrong } },
      axisLabel: { ...axisText(t), formatter: monthLabel },
      axisPointer: { type: "shadow", shadowStyle: { color: t.tint } },
    },
    yAxis: { type: "value", show: false },
    series,
    tooltip: {
      ...chartBase(t).tooltip,
      formatter: (params) => params.filter((p) => p.data && p.data.bill).map(({ data: { bill }, color }) =>
        tipHead(t, `${bill.service_type} · ${fmtDay(bill.period_start)} – ${fmtDay(addDays(bill.period_end, -1), { month: "short", day: "numeric", year: "numeric" })}`) +
        tipRow(services.length > 1 ? color : "", fmtUsd(bill.total_amount_usd),
          `${fmtNum(bill.usage, 0)} ${bill.unit}${bill.estimated ? " · estimated read" : ""}`)).join(""),
    },
  }, REPLACE);
  chart.resize();
  chart.getZr().off("click");
  chart.getZr().on("click", (event) => {   // anywhere in a bill's column
    const period = periods[chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX)];
    const idx = cycleWindows().findIndex((w) => w.bill && w.bill.period_end === period);
    if (idx < 0) return;
    shiftCycle(idx - state.cycleIdx);
    $("cycle").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// History charts are only drawn while visible — echarts can't size a chart
// inside a hidden container.
$("history-btn").addEventListener("click", () => {
  const section = $("history");
  section.hidden = !section.hidden;
  $("history-btn").classList.toggle("active", !section.hidden);
  $("history-btn").setAttribute("aria-expanded", String(!section.hidden));
  if (!section.hidden) {
    renderHistory();
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

// ------------------------------------------------------------- table views --

// `rowKey` names a column whose value identifies the row, making rows
// clickable; `selected` marks the row with that key.
function buildTable(container, columns, rows, rowKey, selected) {
  const cell = (row, col) => {
    const v = row[col.key];
    return `<td${typeof v === "number" ? ' class="num"' : ""}>${esc(col.fmt ? col.fmt(v) : v ?? "–")}</td>`;
  };
  const attrs = (row) => (rowKey
    ? ` data-key="${esc(row[rowKey])}"${row[rowKey] === selected ? ' class="on"' : ""}` : "");
  container.innerHTML =
    `<table><thead><tr>${columns.map((c) =>
      `<th${rows.length && typeof rows[0][c.key] === "number" ? ' class="num"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) =>
      `<tr${attrs(r)}>${columns.map((c) => cell(r, c)).join("")}</tr>`).join("")}</tbody></table>`;
}

function fillTable(name) {
  if (name === "cycle") {
    const win = currentWin();
    const unit = intervalFor("daily")?.unit ?? "";
    if (!win) return;
    let running = 0;
    buildTable($("cycle-table"), [
      { key: "day", label: "Day", fmt: (v) => fmtDay(v, DAY_FMT) },
      { key: "value", label: `Usage (${unit})`, fmt: (v) => fmtNum(v, 2) },
      { key: "cost", label: "Cost ($)", fmt: (v) => fmtNum(v, 2) },
      { key: "running", label: `Running total (${unit})`, fmt: (v) => fmtNum(v, 1) },
    ], windowDays(win).map((d) => ({
      day: d.day, value: d.value, cost: d.hasCost ? d.cost : null, running: (running += d.value),
    })), "day", state.selectedDay);
  } else if (name === "day") {
    const res = detailRes();
    const interval = res && intervalFor(res);
    if (!interval || !state.selectedDay) return;
    const rows = [];
    for (const entry of interval.series) {
      for (let i = 0; i < entry.starts.length; i++) {
        if (!entry.starts[i].startsWith(state.selectedDay)) continue;
        rows.push({
          start: entry.starts[i], stream: entry.name,
          value: entry.values[i],
          cost: !entry.costs || entry.costs[i] == null ? null : entry.costs[i],
        });
      }
    }
    rows.sort((a, b) => (a.start < b.start ? -1 : 1));
    buildTable($("day-table"), [
      { key: "start", label: "Start", fmt: (v) => fmtStamp(new Date(v).getTime(), res) },
      { key: "stream", label: "Series" },
      { key: "value", label: `Usage (${interval.unit})`, fmt: (v) => fmtNum(v, 3) },
      { key: "cost", label: "Cost ($)", fmt: (v) => fmtNum(v, 3) },
    ], rows);
  } else if (name === "monthly") {
    const monthly = state.data.monthly || [];
    buildTable($("monthly-table"), [
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

// A table takes its chart's place; in the cycle table a row selects its day.
document.querySelectorAll(".table-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const wrap = $(btn.dataset.for + "-table");
    wrap.hidden = !wrap.hidden;
    wrap.parentElement.classList.toggle("as-table", !wrap.hidden);
    if (wrap.previousElementSibling) btn.textContent = wrap.hidden ? "Table" : "Chart";
    else btn.classList.toggle("active", !wrap.hidden);   // a table with no chart to replace
    if (!wrap.hidden) fillTable(btn.dataset.for);
    else {
      Object.values(charts).forEach((c) => c.resize());
      renderAll();
    }
  });
});
$("cycle-table").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-key]");
  if (row) selectDay(row.dataset.key);
});

// --------------------------------------------------------------- controls --

function wireTabs(id, attr, onPick) {
  $(id).addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    syncTabs(id, attr, btn.dataset[attr]);
    onPick(btn.dataset[attr]);
  });
}

function syncTabs(id, attr, value) {
  $(id).querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset[attr] === String(value)));
}

const pick = (key, field) => (value) => {
  localStorage.setItem(key, value);
  state[field] = value;
  renderAll();
};
wireTabs("metric-seg", "metric", pick("metric", "metric"));
wireTabs("view-seg", "view", pick("dayView", "view"));
wireTabs("res-seg", "res", pick("detailRes", "detailRes"));
syncTabs("metric-seg", "metric", state.metric);
syncTabs("view-seg", "view", state.view);

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
  $("data-through").textContent = state.data.last_read
    ? "Read through " + new Date(state.data.last_read).toLocaleString("en-US", TIME_FMT)
    : "";
  checkFreshness();
  // Cost toggle only makes sense when a cost series exists.
  const anyCost = Object.values(state.data.intervals || {})
    .some((iv) => iv.series.some((s) => s.costs));
  $("metric-seg").hidden = !anyCost;
  if (!anyCost && state.metric === "cost") {
    state.metric = "usage";
    syncTabs("metric-seg", "metric", "usage");
  }
  // Default day: the newest (also after an update that brought in newer days
  // while the previous newest was selected).
  const all = dayList();
  if (all.length && (!state.selectedDay || !all.includes(state.selectedDay))) {
    state.selectedDay = all[all.length - 1];
    state.cycleIdx = 0;
  }
  const kw = alwaysOnEstimate();
  $("always-on").textContent = kw
    ? `Always-on load is about ${fmtNum(kw * 1000, 0)} W (the lowest hours of the past week).` : "";
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
    checkFreshness();
  }
}

async function startUpdate() {
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
// behind it: pull (cheap, often empty). The server decides when a pull is due
// (30 min after a success, sooner after a failure), so every tab agrees and a
// reload retries. The badge means "old, and the last pull failed" — while a
// pull runs the banner shows it, and after a clean one there is nothing newer.
const STALE_MS = 4 * 3600e3;

async function checkFreshness() {
  const last = state.data?.last_read;
  const stale = !last || Date.now() - new Date(last).getTime() > STALE_MS;
  let job;
  try {
    job = await getJson("/api/job");
  } catch {
    $("stale-badge").hidden = !stale || polling; // server unreachable
    return;
  }
  if (polling) {
    $("stale-badge").hidden = true;
    return;
  }
  if (job.running) {
    pollJob();
    return;
  }
  $("stale-badge").hidden = !(stale && job.failing);
  if (stale && job.check_due) startUpdate().catch(() => {});
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
  // loadData() already ran the freshness check (and started a pull if one was
  // due); here only re-surface a failure left by an earlier pull.
  const job = await getJson("/api/job");
  if (!job.running && job.error && !polling) {
    setBanner({ text: job.error, error: true, login: job.needs_login || job.kind === "login" });
  }
  setInterval(checkFreshness, 60e3);
}

init();
