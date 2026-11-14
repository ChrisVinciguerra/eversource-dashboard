"""Anomaly flags computed from the raw meter reads alone.

No device knowledge is involved: both detectors compare the metered total
against its own recent history.

- "overnight_baseline": the house's overnight floor (a low percentile of the
  01:00-05:00 buckets, read as continuous watts) stepped up versus the trailing
  two weeks. Something new is drawing power around the clock, whatever it is.
  Because the comparison is against a trailing median, a persistent new load
  flags for roughly a week and then becomes the new normal.
- "high_day": a full day's total far above the median of recent same weekdays.

Dates are taken from the local-time half of the ISO start strings, so no
timezone conversion happens here.
"""

from __future__ import annotations

from datetime import date, timedelta
from statistics import median

import pandas as pd

from .config import Json

NIGHT_HOURS = range(1, 5)  # 01:00-04:59 local
BASELINE_PCTL = 0.10
BASELINE_MIN_KW = 0.08  # ~80 W absolute step, and
BASELINE_MIN_RATIO = 1.35  # ...at least 35% above typical
BASELINE_LOOKBACK = 14
BASELINE_MIN_HISTORY = 7
RUN_MIN_DAYS = 2  # one odd night is noise; two in a row is a load

DAY_LOOKBACK = 8  # same-weekday samples to compare against
DAY_MIN_SAMPLES = 4
DAY_MIN_RATIO = 1.5
DAY_MIN_EXCESS_KWH = 3.0

RECENT_DAYS = 45  # only surface flags this close to the newest data
MAX_FLAGS = 8


def _fmt_day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.strftime('%b')} {d.day}"


def _fmt_w(kw: float) -> str:
    return f"{round(kw * 1000 / 10) * 10:g} W"


def compute_flags(frame: pd.DataFrame, hours_per_bucket: float) -> list[Json]:
    """Return anomaly flags for one interval dataset (finest available).

    `frame` is a merged interval frame (start/value, possibly several streams
    summed together here); `hours_per_bucket` is 0.25 or 1.
    """
    buckets: dict[str, float] = {}  # "YYYY-MM-DDTHH:MM" -> kWh
    for start, value in zip(frame["start"], frame["value"]):
        if pd.notna(value):
            key = str(start)[:16]
            buckets[key] = buckets.get(key, 0.0) + float(value)
    if not buckets:
        return []

    night: dict[str, list[float]] = {}
    day_total: dict[str, float] = {}
    day_count: dict[str, int] = {}
    for key, kwh in buckets.items():
        day, hour = key[:10], int(key[11:13])
        day_total[day] = day_total.get(day, 0.0) + kwh
        day_count[day] = day_count.get(day, 0) + 1
        if hour in NIGHT_HOURS:
            night.setdefault(day, []).append(kwh)

    days = sorted(day_total)
    flags = _overnight_flags(days, night, hours_per_bucket)
    flags += _high_day_flags(days, day_total, day_count, hours_per_bucket)

    cutoff = str(date.fromisoformat(days[-1]) - timedelta(days=RECENT_DAYS))
    flags = [f for f in flags if f["date"] >= cutoff]
    flags.sort(key=lambda f: f["date"], reverse=True)
    return flags[:MAX_FLAGS]


def _overnight_flags(
    days: list[str], night: dict[str, list[float]], hours: float
) -> list[Json]:
    """Days whose overnight floor stepped up vs the trailing median, as runs."""
    expected = int(len(NIGHT_HOURS) / hours)
    baselines: list[tuple[str, float]] = []  # (day, kW floor)
    for day in days:
        values = sorted(night.get(day, []))
        if len(values) < 0.75 * expected:
            continue
        baselines.append((day, values[int(len(values) * BASELINE_PCTL)] / hours))

    elevated: list[tuple[str, float, float]] = []  # (day, kW, typical kW)
    for i, (day, kw) in enumerate(baselines):
        prior = [b for _, b in baselines[max(0, i - BASELINE_LOOKBACK) : i]]
        if len(prior) < BASELINE_MIN_HISTORY:
            continue
        typical = median(prior)
        if kw - typical >= BASELINE_MIN_KW and kw >= BASELINE_MIN_RATIO * typical:
            elevated.append((day, kw, typical))

    # Collapse consecutive calendar days into one flag per episode.
    flags: list[Json] = []
    run: list[tuple[str, float, float]] = []
    last_day = baselines[-1][0] if baselines else None

    def close_run() -> None:
        if len(run) < RUN_MIN_DAYS:
            return
        start, end = run[0][0], run[-1][0]
        kw = median(r[1] for r in run)
        typical = run[0][2]
        ongoing = end == last_day
        when = f"since {_fmt_day(start)}" if ongoing else (
            _fmt_day(start) if start == end else f"{_fmt_day(start)}–{_fmt_day(end)}"
        )
        flags.append(
            {
                "kind": "overnight_baseline",
                "date": start,
                "end_date": end,
                "ongoing": ongoing,
                "watts": round(kw * 1000),
                "typical_watts": round(typical * 1000),
                "headline": f"New overnight load {when}",
                "detail": f"the 1–5am floor ran ~{_fmt_w(kw)}, typically ~{_fmt_w(typical)}",
            }
        )

    for item in elevated:
        if run and date.fromisoformat(item[0]) - date.fromisoformat(run[-1][0]) != timedelta(days=1):
            close_run()
            run = []
        run.append(item)
    close_run()
    return flags


def _high_day_flags(
    days: list[str],
    day_total: dict[str, float],
    day_count: dict[str, int],
    hours: float,
) -> list[Json]:
    """Full days far above the median of their recent same weekdays."""
    expected = int(24 / hours)
    full = [d for d in days if day_count[d] >= 0.9 * expected]
    by_weekday: dict[int, list[str]] = {}
    flags: list[Json] = []
    for day in full:
        weekday = date.fromisoformat(day).weekday()
        prior = by_weekday.setdefault(weekday, [])
        samples = [day_total[d] for d in prior[-DAY_LOOKBACK:]]
        if len(samples) >= DAY_MIN_SAMPLES:
            typical = median(samples)
            total = day_total[day]
            if total >= DAY_MIN_RATIO * typical and total - typical >= DAY_MIN_EXCESS_KWH:
                name = date.fromisoformat(day).strftime("%A")
                flags.append(
                    {
                        "kind": "high_day",
                        "date": day,
                        "end_date": day,
                        "ongoing": False,
                        "kwh": round(total, 1),
                        "typical_kwh": round(typical, 1),
                        "headline": f"{_fmt_day(day)} used {total:.0f} kWh — {total / typical:.1f}× a typical {name}",
                        "detail": f"recent {name}s ran ~{typical:.0f} kWh",
                    }
                )
        prior.append(day)
    return flags
