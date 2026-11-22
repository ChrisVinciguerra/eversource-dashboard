"""Runs of the household's known big appliances, read off the meter's shape.

The meter only sees the whole house, but three loads here are recognisable:
each holds the house at a steady level for an hour or more. A run is a
stretch of 15-minute reads at or above RUN_KW; what it is called depends on
its length, level and season.

- Dishwasher (heavy / heat-dry cycle): 3 to 4¼ hours near 0.5-0.7 kW with a
  heating bump to ~1 kW.
- Space heater and window AC: a steady 0.5-0.9 kW. They draw too alike to
  tell apart by wattage, so the month decides (see steady_load_name).

These are guesses from shape, not measurements; anything that does not match
is left unnamed.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from statistics import median, quantiles

from .config import Json

RUN_KW = 0.42  # the house is "running something big" at or above this
MIN_SLOTS = 4  # an hour
STEADY_KW = (0.5, 0.9)
DISHWASHER_HOURS = (3.0, 4.25)
DISHWASHER_KW = (0.48, 0.68)
DISHWASHER_BUMP_KW = 0.85

STEADY_BY_MONTH = {
    **dict.fromkeys((6, 7, 8), "window AC"),
    **dict.fromkeys((10, 11, 12, 1, 2, 3, 4), "space heater"),
    **dict.fromkeys((5, 9), "space heater or window AC"),
}


def steady_load_name(month: int) -> str:
    """What a steady 0.5-0.9 kW load most likely is in this month."""
    return STEADY_BY_MONTH[month]


def _name(kws: list[float], month: int) -> str | None:
    hours, mid = len(kws) / 4, median(kws)
    if (
        DISHWASHER_HOURS[0] <= hours <= DISHWASHER_HOURS[1]
        and DISHWASHER_KW[0] <= mid <= DISHWASHER_KW[1]
        and max(kws) >= DISHWASHER_BUMP_KW
    ):
        return "dishwasher"
    low, _, high = quantiles(kws, n=4)
    if STEADY_KW[0] <= mid <= STEADY_KW[1] and low >= 0.8 * mid and high <= 1.25 * mid:
        return steady_load_name(month)
    return None


def detect_loads(meter: dict[str, float]) -> list[Json]:
    """Named appliance runs from {"YYYY-MM-DDTHH:MM": kWh per 15-min slot}.

    Each run is {"name", "start", "end" (local wall time, end exclusive),
    "kwh"}; kwh is what the run drew above the idle level around it.
    """
    slots = sorted((datetime.fromisoformat(key), kwh * 4) for key, kwh in meter.items())
    step = timedelta(minutes=15)
    loads: list[Json] = []
    i = 0
    while i < len(slots):
        j = i
        while j < len(slots) and slots[j][1] >= RUN_KW and slots[j][0] - slots[i][0] == (j - i) * step:
            j += 1
        if j - i >= MIN_SLOTS:
            kws = [kw for _, kw in slots[i:j]]
            name = _name(kws, slots[i][0].month)
            if name:
                around = [kw for _, kw in slots[max(0, i - 2) : i] + slots[j : j + 2]]
                idle = min(around, default=0.0)
                loads.append({
                    "name": name,
                    "start": f"{slots[i][0]:%Y-%m-%dT%H:%M}",
                    "end": f"{slots[j - 1][0] + step:%Y-%m-%dT%H:%M}",
                    "kwh": round(sum(kw - idle for kw in kws) / 4, 2),
                })
        i = max(j, i + 1)
    return loads
