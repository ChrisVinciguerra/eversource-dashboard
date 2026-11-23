"""Things worth the homeowner's attention, computed from the meter reads alone.

Few flags, about now: at most MAX_FLAGS, most important first, and only for
things still going on or that ended within the last RECENT_DAYS of data.

- "floor_shift": the always-on floor (what the house draws when nothing is
  happening) on at least five of the past seven days sits well above the
  eight weeks before it. Something new is on around the clock. The
  comparison is against a trailing window, so a load that stays becomes the
  new normal and stops flagging after about five weeks.
- "busy_stretch": a run of days well above a normal day, as one episode with
  its total extra energy and cost, and a note when most of it was one steady
  load (which the 15-minute shape shows). An ordinary busy day is not
  flagged; the episode has to add up to MIN_EPISODE_KWH.

"Normal" is the median day of the prior eight weeks, with no weekday split
(long enough that a two-week stretch does not become its own baseline).
Dates are taken from the local-time half of the ISO start strings, so no
timezone conversion happens here.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import median, quantiles
from typing import TYPE_CHECKING

import pandas as pd

from .loads import STEADY_KW, steady_load_name

if TYPE_CHECKING:
    from .config import Json

RECENT_DAYS = 7  # an episode that ended longer ago than this is old news
MAX_FLAGS = 3
LOOKBACK = 56  # days that define "normal" (day total and floor alike)
MIN_HISTORY = 14

HIGH_DAY_KWH = 3.0  # a day this far above normal (and 1.5x it) is "high"
HIGH_DAY_RATIO = 1.5
MIN_EPISODE_KWH = 20.0  # total extra energy before a stretch is worth a flag
BIG_LOAD_KW = 0.4  # a 15-minute read above this means something big is on
MIN_BIG_READS = 4  # an hour of them before a stretch can be one big load

FLOOR_PCTL = 0.03  # the day's floor: its third-lowest 15-minute read
FLOOR_WINDOW = 7
FLOOR_MIN_KW = 0.04  # ~1 kWh a day, around $10 a month
FLOOR_MIN_RATIO = 1.5


def _span(start: str, end: str) -> str:
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    if a == b:
        return f"{a:%b} {a.day}"
    return (
        f"{a:%b} {a.day}–{b.day}"
        if a.month == b.month
        else f"{a:%b} {a.day}–{b:%b} {b.day}"
    )


def _watts(kw: float) -> str:
    return f"{round(kw * 100) * 10} W"


def compute_flags(
    frame: pd.DataFrame,
    hours_per_bucket: float,
    rate_by_day: dict[str, float] | None = None,
) -> list[Json]:
    """Return the flags for one interval dataset (finest available).

    `frame` is a merged interval frame (start/value, possibly several streams
    summed together here); `hours_per_bucket` is 0.25 or 1; `rate_by_day`
    maps a day to $/kWh (omit it and the flags carry no dollar figures).
    """
    buckets: dict[str, float] = defaultdict(float)  # "YYYY-MM-DDTHH:MM" -> kWh
    for start, value in zip(frame["start"], frame["value"], strict=True):
        if pd.notna(value):
            buckets[str(start)[:16]] += float(value)
    reads: dict[str, list[float]] = defaultdict(list)  # day -> kW per bucket
    for key in sorted(buckets):
        reads[key[:10]].append(buckets[key] / hours_per_bucket)
    if not reads:
        return []
    days = sorted(reads)
    total = {d: sum(reads[d]) * hours_per_bucket for d in days}
    full = [d for d in days if len(reads[d]) >= 0.9 * 24 / hours_per_bucket]
    rates = rate_by_day or {}

    flags = _floor_flag(full, reads, rates)
    flags += _busy_stretches(days, full, reads, total, hours_per_bucket, rates)
    # Still-going things first, then by what they cost.
    flags.sort(key=lambda f: (not f["ongoing"], -f["kwh"]))
    return flags[:MAX_FLAGS]


def _floor_flag(
    full: list[str], reads: dict[str, list[float]], rates: dict[str, float]
) -> list[Json]:
    """The past week's always-on floor against the eight weeks before it."""
    if len(full) < FLOOR_WINDOW + MIN_HISTORY:
        return []
    floor = {d: sorted(reads[d])[int(len(reads[d]) * FLOOR_PCTL)] for d in full}
    recent = full[-FLOOR_WINDOW:]
    earlier = full[-FLOOR_WINDOW - LOOKBACK : -FLOOR_WINDOW]
    # Third-lowest of the week: five of the seven days have to be raised, so
    # a load that comes and goes for a day or two does not count.
    now = sorted(floor[d] for d in recent)[2]
    before = median(floor[d] for d in earlier)
    step = now - before
    if step < FLOOR_MIN_KW or now < FLOOR_MIN_RATIO * before:
        return []
    # Onset: the week's first raised day, or earlier while days stay raised.
    i = len(full) - FLOOR_WINDOW
    while floor[full[i]] <= before + step / 2:
        i += 1
    while i > 0 and floor[full[i - 1]] > before + step / 2:
        i -= 1
    start = full[i]
    kwh_month = step * 24 * 30
    rate = rates.get(full[-1])
    cost = f" · ~${kwh_month * rate:.0f}/mo" if rate else ""
    return [
        {
            "kind": "floor_shift",
            "date": start,
            "end_date": full[-1],
            "ongoing": True,
            "kwh": round(kwh_month, 1),
            "watts": round(now * 1000),
            "typical_watts": round(before * 1000),
            "headline": f"Always-on load up about {_watts(step)} "
            f"since {_span(start, start)}",
            "value": f"+{_watts(step)}{cost}",
            "detail": f"Most of the past week the house idled at ~{_watts(now)}, "
            f"up from ~{_watts(before)}: about {kwh_month:.0f} kWh a month "
            "if it stays on.",
        }
    ]


def _busy_stretches(  # noqa: PLR0913, PLR0917 -- the day's reads, as computed above
    days: list[str],
    full: list[str],
    reads: dict[str, list[float]],
    total: dict[str, float],
    hours: float,
    rates: dict[str, float],
) -> list[Json]:
    """Recent runs of days well above normal, one flag per run."""
    # Extra energy per day over the median of the full days before it. A
    # partial newest day counts with what it has used so far.
    extra: dict[str, float] = {}
    normal: dict[str, float] = {}
    for day in days:
        prior = [total[d] for d in full if d < day][-LOOKBACK:]
        if len(prior) >= MIN_HISTORY:
            normal[day] = median(prior)
            extra[day] = total[day] - normal[day]
    high = [
        d
        for d in extra
        if extra[d] >= max(HIGH_DAY_KWH, (HIGH_DAY_RATIO - 1) * normal[d])
    ]

    # One ordinary day in between does not end a stretch.
    runs: list[list[str]] = []
    for day in high:
        if runs and date.fromisoformat(day) - date.fromisoformat(
            runs[-1][-1]
        ) <= timedelta(days=2):
            runs[-1].append(day)
        else:
            runs.append([day])

    last = date.fromisoformat(days[-1])
    # Not over until two ordinary days have passed (a partial newest day
    # that is not high yet says nothing either way).
    still_on = str(last - timedelta(days=1 if days[-1] in full else 2))
    flags: list[Json] = []
    for run in runs:
        start, end = run[0], run[-1]
        span = [d for d in days if start <= d <= end]
        kwh = sum(extra[d] for d in span)
        if kwh < MIN_EPISODE_KWH or (last - date.fromisoformat(end)).days > RECENT_DAYS:
            continue
        ongoing = end >= still_on
        usd = (
            sum(extra[d] * rates[d] for d in span)
            if all(d in rates for d in span)
            else None
        )
        typical = median(normal[d] for d in span)
        flags.append(
            {
                "kind": "busy_stretch",
                "date": start,
                "end_date": end,
                "ongoing": ongoing,
                "kwh": round(kwh, 1),
                "typical_kwh": round(typical, 1),
                "usd": round(usd, 2) if usd else None,
                "headline": (
                    f"{kwh:.0f} kWh above normal since {_span(start, start)}"
                    if ongoing and start != end
                    else f"{_span(start, end)} ran {kwh:.0f} kWh above normal"
                ),
                "value": f"+{kwh:.0f} kWh" + (f" · ~${usd:.0f}" if usd else ""),
                "detail": _shape(
                    [kw for d in span for kw in reads[d]],
                    kwh,
                    typical / 24,
                    hours,
                    start,
                )
                + f" A normal day lately is ~{typical:.0f} kWh.",
            }
        )
    return flags


def _shape(
    kws: list[float], extra_kwh: float, normal_kw: float, hours: float, start: str
) -> str:
    """Say what the stretch's reads look like: one steady load, or not."""
    big = [kw for kw in kws if kw >= BIG_LOAD_KW]
    if (
        len(big) < MIN_BIG_READS
        or sum(kw - normal_kw for kw in big) * hours < 0.6 * extra_kwh
    ):
        return "Spread across the days, not one big load."
    on_hours = f"{len(big) * hours:.0f} hours"
    low, mid, high = quantiles(big, n=4)
    if low >= 0.8 * mid and high <= 1.25 * mid:
        known = (
            f" Looks like the {steady_load_name(date.fromisoformat(start).month)}."
            if STEADY_KW[0] <= mid <= STEADY_KW[1]
            else ""
        )
        return f"Mostly a steady ~{_watts(mid)} load, on for about {on_hours}.{known}"
    return f"Mostly about {on_hours} of heavy use (~{_watts(low)} to ~{_watts(high)})."
