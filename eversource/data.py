"""Merging export folders and shaping the data for the dashboard.

Every exports/ folder is unioned into one continuous span (newest export wins
on overlapping rows), display values are normalized, a derived cost series is
attached to the interval reads, and the result is packed into one JSON payload
the web UI renders from.
"""

from __future__ import annotations

import json
from typing import Any

import pandas as pd

from .config import EXPORT_FIRST_HINT, EXPORT_GLOB, EXPORT_ROOT, Json, NoExports
from .progress import emit

# Dedup keys per dataset: rows matching on these are the same observation, and
# the copy from the newest export folder wins.
DATASET_KEYS: dict[str, list[str]] = {
    "quarter_hour": ["billing_account", "meter", "stream", "start"],
    "hourly": ["billing_account", "meter", "stream", "start"],
    "daily": ["billing_account", "meter", "stream", "start"],
    "monthly": ["billing_account", "meter", "year", "month"],
    "bills": ["billing_account", "service_type", "period_start"],
}

# Datasets made of meter reads, coarsest first.
INTERVAL_DATASETS = ("daily", "hourly", "quarter_hour")

STREAM_NAMES = {
    "netUsage": "Net usage",
    "energyDelivered": "Delivered",
    "energyReceived": "Received",
}
UNIT_NAMES = {"KWH": "kWh", "THERM": "therms", "CCF": "ccf"}

NET_USAGE = STREAM_NAMES["netUsage"]


def merged_exports() -> dict[str, pd.DataFrame]:
    """Return every exports/ folder unioned; newest export wins on overlaps."""
    exports = sorted(p for p in EXPORT_ROOT.glob(EXPORT_GLOB) if p.is_dir())
    if not exports:
        raise NoExports(
            f"no export folders found in {EXPORT_ROOT}/; {EXPORT_FIRST_HINT}"
        )
    emit(f"merging {len(exports)} export(s)")
    data: dict[str, pd.DataFrame] = {}
    for name, keys in DATASET_KEYS.items():
        frames = [
            pd.read_csv(folder / f"{name}.csv")
            for folder in reversed(exports)  # newest first + keep="first" wins
            if (folder / f"{name}.csv").is_file()
        ]
        if frames:
            data[name] = (
                pd.concat(frames, ignore_index=True)
                .drop_duplicates(subset=keys, keep="first")
                .sort_values(keys, ignore_index=True)
            )
    if not data:
        raise NoExports("the export folders contain no CSV files")
    return data


def normalize_display_values(data: dict[str, pd.DataFrame]) -> None:
    """Rewrite raw API values in place into their display forms."""
    for frame in data.values():
        if "stream" in frame.columns:
            frame["stream"] = frame["stream"].map(STREAM_NAMES).fillna(frame["stream"])
        if "unit" in frame.columns:
            frame["unit"] = frame["unit"].map(UNIT_NAMES).fillna(frame["unit"])
        if "service_type" in frame.columns:
            frame["service_type"] = frame["service_type"].str.title()
        if "meter" in frame.columns:
            frame["meter"] = frame["meter"].astype(str)
        # With several meters, series names need the meter to stay distinct.
        if {"stream", "meter"} <= set(frame.columns) and frame["meter"].nunique() > 1:
            frame["stream"] = frame["stream"] + " · " + frame["meter"]


def keep_net_usage_only(data: dict[str, pd.DataFrame]) -> None:
    """Drop the delivered/received streams wherever net usage exists.

    Delivered mirrors net usage unless energy flows back to the grid.
    """
    for name in INTERVAL_DATASETS:
        frame = data.get(name)
        if frame is None:
            continue
        is_net = frame["stream"].str.startswith(NET_USAGE)
        if is_net.any():
            data[name] = frame[is_net].reset_index(drop=True)


def unit_of(frame: pd.DataFrame) -> str:
    """Return the unit the frame's usage column is measured in."""
    return str(frame["unit"].iloc[0])


def add_effective_rate_cost(frame: pd.DataFrame, bills: pd.DataFrame | None) -> bool:
    """Add cost_usd per read: usage × its billing period's effective rate.

    The rate is total bill / billed usage, so fixed charges are spread in.
    """
    if bills is None:
        return False
    billed = bills[(bills["unit"] == unit_of(frame)) & (bills["usage"] > 0)]
    if billed.empty:
        return False
    billed = billed.sort_values("period_start")
    rates = pd.DataFrame(
        {
            "d": pd.to_datetime(billed["period_start"]),
            "rate": billed["total_amount_usd"] / billed["usage"],
        }
    )
    # Map each read's day onto the bill period containing it; days past the
    # newest bill use its rate, days before the oldest use the oldest's.
    days = pd.DataFrame({"day": sorted(frame["start"].str[:10].unique())})
    days["d"] = pd.to_datetime(days["day"])
    matched = pd.merge_asof(days, rates, on="d")
    rate_by_day = dict(zip(matched["day"], matched["rate"].bfill()))
    frame["effective_rate_usd"] = frame["start"].str[:10].map(rate_by_day).round(4)
    frame["cost_usd"] = (frame["value"] * frame["effective_rate_usd"]).round(5)
    return True


# ----------------------------------------------------------- JSON payload ---


def _records(frame: pd.DataFrame | None) -> list[Json] | None:
    """Return a dataframe as plain JSON records (NaN -> null, numpy -> native)."""
    if frame is None:
        return None
    return json.loads(frame.to_json(orient="records"))


def _column(series: pd.Series) -> list[Any]:
    """Return a column as a JSON-safe list (NaN -> None)."""
    return [None if pd.isna(value) else value for value in series]


def _interval_payload(frame: pd.DataFrame, has_cost: bool) -> Json:
    """Pack one interval dataset into columnar per-stream series."""
    series = []
    for stream, group in frame.groupby("stream", sort=False):
        entry: Json = {
            "name": str(stream),
            "starts": group["start"].tolist(),
            "values": _column(group["value"]),
        }
        if has_cost:
            entry["costs"] = _column(group["cost_usd"])
        series.append(entry)
    return {"unit": unit_of(frame), "series": series}


def build_payload() -> Json:
    """Return the full dashboard payload from the merged export folders."""
    data = merged_exports()
    normalize_display_values(data)
    keep_net_usage_only(data)
    bills = data.get("bills")

    intervals: Json = {}
    last_read: str | None = None
    for name in INTERVAL_DATASETS:
        frame = data.get(name)
        if frame is None:
            continue
        has_cost = add_effective_rate_cost(frame, bills)
        intervals[name] = _interval_payload(frame, has_cost)
        # Finest dataset wins (the loop is coarsest-first): a partial day's
        # daily bucket "ends" at the next midnight, past the actual reads.
        last_read = frame["end"].max() or last_read

    return {
        "intervals": intervals,
        "monthly": _records(data.get("monthly")),
        "bills": _records(bills),
        "last_read": last_read,
    }


# The merge is pure function of the CSV files, so cache on their stats.
_cache: tuple[tuple[tuple[str, float, int], ...], Json] | None = None


def _signature() -> tuple[tuple[str, float, int], ...]:
    return tuple(
        sorted(
            (str(path), path.stat().st_mtime, path.stat().st_size)
            for folder in EXPORT_ROOT.glob(EXPORT_GLOB)
            if folder.is_dir()
            for path in folder.glob("*.csv")
        )
    )


def cached_payload() -> Json:
    """Return build_payload(), re-merging only when the CSVs change."""
    global _cache
    signature = _signature()
    if _cache is None or _cache[0] != signature:
        _cache = (signature, build_payload())
    return _cache[1]
