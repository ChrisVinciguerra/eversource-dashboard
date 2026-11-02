"""Known devices: loads whose usage can be virtually subtracted in the dashboard.

A device is one JSON file in devices/*.json describing a power stream in
15-minute slots:

    {
      "name": "Fridge",
      "readings": {                       # actual metered usage (optional)
        "start": "2026-05-04T16:00",      # coverage window, local wall time
        "end": "2026-11-01T20:45",
        "values_kwh": {"2026-11-01T16:00": 0.0123}   # zero slots omitted
      },
      "pattern": {"values_kwh": [0.01, 0.02]}        # repeating fallback
    }

Inside the readings window, a missing slot means the device drew nothing.
Outside it (and when there are no readings at all), "pattern" is used: kWh per
slot, repeating indefinitely, aligned to local midnight. At least one of the
two must be present.

A file may instead carry only {"source": ...} — a local path, an ssh
"host:path", or an http(s) URL serving the document above. refresh_device_sources() re-pulls each
source (the page triggers it on open) and writes the fetched document back
into the file, so it doubles as a cache: an unreachable source keeps serving
the last successful fetch.
"""

from __future__ import annotations

import json
import pathlib
import shlex
import subprocess
import urllib.request

from .config import DEVICE_ROOT, Json
from .progress import emit

# Quarter-hour slots per bucket of each interval dataset.
SLOTS_PER_BUCKET = {"quarter_hour": 1, "hourly": 4, "daily": 96}

# Readings keys and window bounds are local wall time to the minute.
_KEY_LEN = len("2026-01-01T00:00")


def parse_spec(spec: Json) -> Json:
    """Validate a device document into {"name", "cycle", "readings", "window", …}.

    Raises KeyError/TypeError/ValueError on a malformed document.
    """
    name = str(spec["name"])
    cycle = (
        [float(v) for v in spec["pattern"]["values_kwh"]] if "pattern" in spec else []
    )
    readings: dict[str, float] = {}
    ports: dict[str, dict[str, float]] = {}
    window: tuple[str, str] | None = None
    if "readings" in spec:
        raw = spec["readings"]
        window = (str(raw["start"])[:_KEY_LEN], str(raw["end"])[:_KEY_LEN])
        readings = {str(k)[:_KEY_LEN]: float(v) for k, v in raw["values_kwh"].items()}
        ports = {
            str(port): {str(k)[:_KEY_LEN]: float(v) for k, v in vals.items()}
            for port, vals in raw.get("ports", {}).items()
        }
    if not cycle and window is None:
        raise ValueError("device has neither a pattern nor readings")
    overlaps = spec.get("overlaps_with", [])
    return {
        "name": name,
        "cycle": cycle,
        "readings": readings,
        "window": window,
        "ports": ports,
        "overlaps_with": [overlaps] if isinstance(overlaps, str) else list(overlaps),
    }


def load_devices() -> list[Json]:
    """Return the parsed device specs from devices/*.json."""
    if not DEVICE_ROOT.is_dir():
        return []
    devices: list[Json] = []
    for path in sorted(DEVICE_ROOT.glob("*.json")):
        try:
            spec = json.loads(path.read_text())
            if "source" in spec and not ({"pattern", "readings"} & set(spec)):
                continue  # remote spec that has never been fetched yet
            devices.append(parse_spec(spec))
        except (KeyError, TypeError, ValueError) as error:
            emit(f"skipping device file {path.name}: {error}")
    return devices


def _fetch_device_source(source: str) -> Json:
    """Fetch a device document from a local path, ssh "host:path", or http(s) URL."""
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=5) as response:
            return json.loads(response.read())
    if source.startswith(("/", "~")):
        return json.loads(pathlib.Path(source).expanduser().read_text())
    host, _, path = source.partition(":")
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
         host, "cat", shlex.quote(path)],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        raise OSError(proc.stderr.strip() or f"ssh {host} exited {proc.returncode}")
    return json.loads(proc.stdout)


def refresh_device_sources() -> bool:
    """Re-pull every devices/*.json that names a remote source.

    Best effort: an unreachable source (host asleep, network down) keeps the
    file's cached document from the last successful fetch. Returns whether any
    file actually changed — the payload cache keys on device file stats, so a
    changed file is picked up on the next build.
    """
    changed = False
    if not DEVICE_ROOT.is_dir():
        return changed
    for path in sorted(DEVICE_ROOT.glob("*.json")):
        try:
            spec = json.loads(path.read_text())
        except ValueError:
            continue
        source = spec.get("source")
        if not source:
            continue
        try:
            fetched = _fetch_device_source(source)
            parse_spec(fetched)  # reject malformed documents, keep the cache
            text = json.dumps({"source": source, **fetched}, indent=2) + "\n"
        except Exception as error:
            emit(f"device source {path.name}: {error}")
            continue
        if text != path.read_text():
            path.write_text(text)
            changed = True
    return changed


def device_entry(
    device: Json,
    starts: list[str],
    res: str,
    rate_by_day: dict[str, float] | None,
    cutoff: str | None,
) -> Json:
    """Expand a device's stream onto a dataset's bucket starts.

    Each bucket sums the device's 15-minute slots it spans: the actual reading
    where the readings window covers the slot (absent reading = device off),
    the repeating pattern elsewhere. cutoff is the end of the last actual
    meter read: the bucket containing it only gets slots up to that point, so
    subtracting a device from a partial day (or hour) doesn't remove usage
    that was never metered.
    """
    cycle: list[float] = device["cycle"]
    readings: dict[str, float] = device["readings"]
    window: tuple[str, str] | None = device["window"]
    width = SLOTS_PER_BUCKET[res]
    cutoff_slot = (
        (int(cutoff[11:13]) * 60 + int(cutoff[14:16])) // 15 if cutoff else None
    )
    values = []
    for start in starts:
        # Slot index from the local time of day in the ISO string, so slots
        # stay aligned to midnight across DST changes.
        day = start[:10]
        slot = (int(start[11:13]) * 60 + int(start[14:16])) // 15
        slots = width
        if cutoff_slot is not None and day == cutoff[:10]:
            slots = max(0, min(width, cutoff_slot - slot))
        total = 0.0
        for k in range(slots):
            s = slot + k
            key = f"{day}T{s // 4:02d}:{s % 4 * 15:02d}"
            if window and window[0] <= key < window[1]:
                total += readings.get(key, 0.0)
            elif cycle:
                total += cycle[s % len(cycle)]
        values.append(round(total, 6))
    entry: Json = {"name": device["name"], "starts": starts, "values": values}
    if rate_by_day:
        entry["costs"] = [
            round(value * rate, 5)
            if (rate := rate_by_day.get(start[:10])) is not None
            else None
            for start, value in zip(starts, values)
        ]
    return entry


# ------------------------------------------------------------------ overlaps --

# Two slot readings are "the same energy seen by two meters" when they agree
# within this fraction (meters sample at different moments and sit on opposite
# sides of the charger's conversion loss).
OVERLAP_TOLERANCE = 0.3


def _overlap_readings(device: Json, other: Json) -> Json | None:
    """A pseudo-device holding the energy both `device` and `other` metered.

    `device` declares overlaps_with and carries per-port readings (e.g. a
    charging station); `other` is a load that may draw through one of those
    ports some of the time (e.g. a laptop that also charges elsewhere). For
    each 15-minute slot both devices cover, a port whose energy matches the
    other device's reading within OVERLAP_TOLERANCE is the same energy metered
    twice; the overlap is the smaller of the two readings.
    """
    if not device["ports"] or not device["window"] or not other["window"]:
        return None
    lo = max(device["window"][0], other["window"][0])
    hi = min(device["window"][1], other["window"][1])
    slots: dict[str, float] = {}
    for key, other_kwh in other["readings"].items():
        if other_kwh <= 0 or not lo <= key < hi:
            continue
        best = 0.0
        for port_values in device["ports"].values():
            port_kwh = port_values.get(key, 0.0)
            if port_kwh <= 0:
                continue
            if abs(port_kwh - other_kwh) <= OVERLAP_TOLERANCE * max(port_kwh, other_kwh):
                best = max(best, min(port_kwh, other_kwh))
        if best:
            slots[key] = round(best, 6)
    if not slots:
        return None
    return {
        "name": f"{device['name']} ∩ {other['name']}",
        "cycle": [],
        "readings": slots,
        "window": (lo, hi),
    }


def overlap_entries(
    devices: list[Json],
    starts: list[str],
    res: str,
    rate_by_day: dict[str, float] | None,
    cutoff: str | None,
) -> list[Json]:
    """Bucketed overlap streams for every overlaps_with pair among `devices`.

    Each entry carries "names" (the pair) so the dashboard can add the overlap
    back exactly once when both devices are being subtracted together.
    """
    by_name = {device["name"]: device for device in devices}
    entries = []
    for device in devices:
        for other_name in device["overlaps_with"]:
            other = by_name.get(other_name)
            if other is None or other is device:
                continue
            pseudo = _overlap_readings(device, other)
            if pseudo is None:
                continue
            entry = device_entry(pseudo, starts, res, rate_by_day, cutoff)
            entry["names"] = [device["name"], other["name"]]
            entries.append(entry)
    return entries
