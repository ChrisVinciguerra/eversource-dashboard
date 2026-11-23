#!/usr/bin/env python3
"""Record this Mac's wall power draw and publish it as a dashboard device.

Stdlib only; Apple Silicon (reads AppleSmartBattery's PowerTelemetryData).
Meant to run forever under launchd — see install_mac_power_agent.sh.

Every SAMPLE_SECONDS it samples the instantaneous wall input power
(SystemPowerIn + AdapterEfficiencyLoss, mW — 0 whenever on battery, which is
correct: the wall sees nothing) and appends to monthly CSVs under --state-dir:

    samples/YYYY-MM.csv: timestamp,elapsed_s,wall_w,battery_mah,battery_mv

The process is frozen while the Mac sleeps, so a gap in the samples is the
sleep record. Charging *during* sleep still comes from the wall, so each gap's
battery charge delta (mAh × voltage, over CHARGE_EFFICIENCY) is logged to
sleep-charge.csv and spread across the gap when aggregating.

Every PUBLISH_SECONDS it rewrites --device-out with the dashboard's device
document (see devices/README.md in this repo): actual kWh per 15-minute slot
over the samples' coverage window, plus the trailing PATTERN_DAYS-day average
as the repeating fallback pattern outside it.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import datetime as dt
import json
import pathlib
import plistlib
import subprocess
import time

SAMPLE_SECONDS = 30
PUBLISH_SECONDS = 15 * 60
PATTERN_DAYS = 14  # averaging window for the fallback pattern
CHARGE_EFFICIENCY = 0.85  # wall Wh per battery Wh gained while asleep
SLOT_MINUTES = 15


def battery_state() -> tuple[float, float | None, float | None]:
    """Return (wall_w, battery_mah, battery_mv) from IORegistry."""
    out = subprocess.run(
        ["ioreg", "-arn", "AppleSmartBattery"],
        capture_output=True,
        timeout=10,
        check=True,
    ).stdout
    info = plistlib.loads(out)[0]
    telemetry = info.get("PowerTelemetryData", {})
    wall_mw = telemetry.get("SystemPowerIn", 0) + telemetry.get(
        "AdapterEfficiencyLoss", 0
    )
    mah = info.get("BatteryData", {}).get("AppleRawCurrentCapacity")
    return wall_mw / 1000.0, mah, info.get("Voltage")


def slot_start(ts: dt.datetime) -> dt.datetime:
    """Return the start of the slot containing `ts`."""
    return ts.replace(
        minute=ts.minute - ts.minute % SLOT_MINUTES, second=0, microsecond=0
    )


def slot_key(ts: dt.datetime) -> str:
    """Return the key of the slot containing `ts`."""
    return f"{slot_start(ts):%Y-%m-%dT%H:%M}"


def append_row(path: pathlib.Path, header: str, row: str) -> None:
    """Append a CSV row, writing the header first on a new file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a") as fh:
        if new:
            fh.write(header + "\n")
        fh.write(row + "\n")


# ------------------------------------------------------------- aggregation --


def load_slot_kwh(state_dir: pathlib.Path) -> tuple[dict[str, float], str, str]:
    """Return ({slot key: kWh}, coverage start, coverage end) from the CSVs.

    Each sample's energy (wall_w × elapsed) lands in the slot containing its
    timestamp; sleep-charge energy is spread uniformly across its gap's slots.
    """
    joules: dict[str, float] = {}
    first = last = None
    for path in sorted((state_dir / "samples").glob("*.csv")):
        with path.open() as fh:
            for row in csv.DictReader(fh):
                ts = dt.datetime.fromisoformat(row["timestamp"])
                first = min(first or ts, ts)
                last = max(last or ts, ts)
                energy = float(row["wall_w"]) * float(row["elapsed_s"])
                if energy > 0:
                    joules[slot_key(ts)] = joules.get(slot_key(ts), 0.0) + energy

    charge_log = state_dir / "sleep-charge.csv"
    if charge_log.exists():
        with charge_log.open() as fh:
            for row in csv.DictReader(fh):
                a = dt.datetime.fromisoformat(row["gap_start"])
                b = dt.datetime.fromisoformat(row["gap_end"])
                total_j = float(row["wall_wh"]) * 3600.0
                cur, span = slot_start(a), (b - a).total_seconds()
                while cur < b:
                    nxt = cur + dt.timedelta(minutes=SLOT_MINUTES)
                    part = (min(nxt, b) - max(cur, a)).total_seconds() / span
                    joules[slot_key(cur)] = (
                        joules.get(slot_key(cur), 0.0) + total_j * part
                    )
                    cur = nxt

    if first is None:
        return {}, "", ""
    kwh = {k: round(j / 3.6e6, 6) for k, j in sorted(joules.items())}
    return (
        {k: v for k, v in kwh.items() if v > 0},
        slot_key(first),
        f"{last:%Y-%m-%dT%H:%M}",
    )


def average_pattern(kwh: dict[str, float], end_day: dt.date) -> list[float]:
    """Mean kWh per midnight-aligned slot over the PATTERN_DAYS trailing days."""
    days = [f"{end_day - dt.timedelta(days=n + 1)}" for n in range(PATTERN_DAYS)]
    slots_per_day = 24 * 60 // SLOT_MINUTES
    totals = [0.0] * slots_per_day
    for key, value in kwh.items():
        if key[:10] in days:
            hour, minute = int(key[11:13]), int(key[14:16])
            totals[(hour * 60 + minute) // SLOT_MINUTES] += value
    return [round(t / PATTERN_DAYS, 6) for t in totals]


def publish(state_dir: pathlib.Path, device_out: pathlib.Path, name: str) -> None:
    """Write the device document the dashboard reads."""
    kwh, start, end = load_slot_kwh(state_dir)
    if not start:  # no samples yet; all-zero slots (on battery) still publish
        return
    doc = {
        "name": name,
        "readings": {
            "start": start,
            "end": end,
            "values_kwh": kwh,
        },
        "pattern": {
            "values_kwh": average_pattern(kwh, dt.datetime.now().astimezone().date())
        },
    }
    device_out.parent.mkdir(parents=True, exist_ok=True)
    device_out.write_text(json.dumps(doc, indent=2) + "\n")


# ------------------------------------------------------------------- loop ---


def main() -> None:
    """Sample wall power forever, publishing every so often."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", default="Mac", help="device name in the dashboard")
    parser.add_argument(
        "--device-out",
        required=True,
        type=pathlib.Path,
        help="device JSON to publish (a devices/*.json points at it)",
    )
    parser.add_argument(
        "--state-dir",
        type=pathlib.Path,
        default=pathlib.Path.home() / ".local/share/energy-dashboard/mac-power",
        help="where the sample CSVs accumulate",
    )
    args = parser.parse_args()

    samples = args.state_dir / "samples"
    prev_t = time.time()
    _, prev_mah, prev_mv = battery_state()
    last_publish = 0.0

    while True:
        time.sleep(SAMPLE_SECONDS)
        now = time.time()
        elapsed = now - prev_t
        try:
            wall_w, mah, mv = battery_state()
        except Exception:  # noqa: BLE001 -- a failed sample is skipped, not fatal
            prev_t = now
            continue

        ts = dt.datetime.now().astimezone()
        if elapsed > SAMPLE_SECONDS * 4:
            # Slept across the gap. The wall still charged the battery if it
            # was plugged in; estimate that energy from the charge delta.
            if None not in (prev_mah, prev_mv, mah, mv) and mah > prev_mah:
                wh = (mah - prev_mah) / 1000 * (prev_mv + mv) / 2 / 1000
                wh /= CHARGE_EFFICIENCY
                gap_start = dt.datetime.fromtimestamp(prev_t).astimezone()
                append_row(
                    args.state_dir / "sleep-charge.csv",
                    "gap_start,gap_end,wall_wh",
                    f"{gap_start.isoformat(timespec='seconds')},"
                    f"{ts.isoformat(timespec='seconds')},{wh:.2f}",
                )
        else:
            append_row(
                samples / f"{ts:%Y-%m}.csv",
                "timestamp,elapsed_s,wall_w,battery_mah,battery_mv",
                f"{ts.isoformat(timespec='seconds')},{elapsed:.1f},{wall_w:.2f},"
                f"{'' if mah is None else mah},{'' if mv is None else mv}",
            )
        prev_t, prev_mah, prev_mv = now, mah, mv

        if now - last_publish >= PUBLISH_SECONDS:
            # Recording continues whatever goes wrong; the next publish retries.
            with contextlib.suppress(Exception):
                publish(args.state_dir, args.device_out, args.name)
            last_publish = now


if __name__ == "__main__":
    main()
