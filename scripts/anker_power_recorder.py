#!/usr/bin/env python3
"""Record an Anker Prime A91B2 charging station and publish it as a device.

Needs anker-solix-api (GitHub, not PyPI) and Python 3.12+ — see
install_anker_power_agent.sh, which builds a venv and runs this under launchd.

The A91B2 publishes per-port telemetry only over Anker's cloud MQTT (the REST
API carries no power data for standalone devices), so this keeps an MQTT
session open on the account that owns the charger, re-sends the realtime
trigger every TRIGGER_SECONDS to hold the ~1 Hz stream, and integrates each
port's watts into joules. Every FLUSH_SECONDS a row of average watts per port
is appended to monthly CSVs under --state-dir:

    samples/YYYY-MM.csv: timestamp,elapsed_s,usbc_1_w,…,usba_2_w

Every PUBLISH_SECONDS it rewrites --device-out with the dashboard's device
document (see devices/README.md): kWh per 15-minute slot, with the per-port
breakdown and `overlaps_with` naming devices (e.g. the MacBook) whose own
meter may see the same energy, so the dashboard can de-duplicate.

Limitations: the AC outlets are switched but not metered (only the 4 USB-C and
2 USB-A ports report power), and nothing is recorded while this Mac sleeps.

The Anker account password lives in the macOS keychain; store it once with
    anker_power_recorder.py --username you@example.com --login
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import datetime
import getpass
import json
import logging
import pathlib
import subprocess
import time

FLUSH_SECONDS = 30
TRIGGER_SECONDS = 60       # realtime trigger re-send (device streams ~5 min)
PUBLISH_SECONDS = 15 * 60
PATTERN_DAYS = 14          # averaging window for the fallback pattern
SLOT_MINUTES = 15
MAX_SAMPLE_GAP = 120.0     # a silence longer than this is a gap, not a sample
MODEL = "A91B2"
PORTS = ("usbc_1", "usbc_2", "usbc_3", "usbc_4", "usba_1", "usba_2")

KEYCHAIN_SERVICE = "energy-dashboard-anker"


def keychain_get(username: str) -> str | None:
    try:
        done = subprocess.run(
            ["security", "find-generic-password",
             "-s", KEYCHAIN_SERVICE, "-a", username, "-w"],
            capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return done.stdout.rstrip("\n") or None


def keychain_set(username: str, password: str) -> None:
    subprocess.run(
        ["security", "add-generic-password", "-U",
         "-s", KEYCHAIN_SERVICE, "-a", username, "-w", password],
        capture_output=True, text=True, check=True,
    )


def slot_start(ts: datetime.datetime) -> datetime.datetime:
    return ts.replace(minute=ts.minute - ts.minute % SLOT_MINUTES,
                      second=0, microsecond=0)


def slot_key(ts: datetime.datetime) -> str:
    return f"{slot_start(ts):%Y-%m-%dT%H:%M}"


def append_row(path: pathlib.Path, header: str, row: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with open(path, "a") as fh:
        if new:
            fh.write(header + "\n")
        fh.write(row + "\n")


# ------------------------------------------------------------- aggregation --


def load_slot_kwh(
    state_dir: pathlib.Path,
) -> tuple[dict[str, float], dict[str, dict[str, float]], str, str]:
    """Return (total {slot: kWh}, {port: {slot: kWh}}, coverage start, end)."""
    joules: dict[str, dict[str, float]] = {port: {} for port in PORTS}
    first = last = None
    for path in sorted((state_dir / "samples").glob("*.csv")):
        with open(path) as fh:
            for row in csv.DictReader(fh):
                ts = datetime.datetime.fromisoformat(row["timestamp"])
                first = min(first or ts, ts)
                last = max(last or ts, ts)
                elapsed = float(row["elapsed_s"])
                key = slot_key(ts)
                for port in PORTS:
                    energy = float(row.get(f"{port}_w") or 0) * elapsed
                    if energy > 0:
                        joules[port][key] = joules[port].get(key, 0.0) + energy
    if first is None:
        return {}, {}, "", ""
    ports = {
        port: {k: round(j / 3.6e6, 6) for k, j in sorted(slots.items())
               if j / 3.6e6 >= 5e-7}
        for port, slots in joules.items()
    }
    ports = {port: slots for port, slots in ports.items() if slots}
    total: dict[str, float] = {}
    for slots in ports.values():
        for k, v in slots.items():
            total[k] = round(total.get(k, 0.0) + v, 6)
    return total, ports, slot_key(first), f"{last:%Y-%m-%dT%H:%M}"


def average_pattern(kwh: dict[str, float], end_day: datetime.date) -> list[float]:
    """Mean kWh per midnight-aligned slot over the PATTERN_DAYS trailing days."""
    days = [f"{end_day - datetime.timedelta(days=n + 1)}" for n in range(PATTERN_DAYS)]
    slots_per_day = 24 * 60 // SLOT_MINUTES
    totals = [0.0] * slots_per_day
    for key, value in kwh.items():
        if key[:10] in days:
            hour, minute = int(key[11:13]), int(key[14:16])
            totals[(hour * 60 + minute) // SLOT_MINUTES] += value
    return [round(t / PATTERN_DAYS, 6) for t in totals]


def publish(state_dir: pathlib.Path, device_out: pathlib.Path,
            name: str, overlaps_with: list[str]) -> None:
    total, ports, start, end = load_slot_kwh(state_dir)
    if not start:
        return
    doc = {
        "name": name,
        "overlaps_with": overlaps_with,
        "readings": {
            "start": start,
            "end": end,
            "values_kwh": total,
            "ports": ports,
        },
        "pattern": {
            "values_kwh": average_pattern(total, datetime.date.today())
        },
    }
    device_out.parent.mkdir(parents=True, exist_ok=True)
    device_out.write_text(json.dumps(doc, indent=2) + "\n")


# -------------------------------------------------------------- MQTT session --


class PortMeter:
    """Integrates per-port instantaneous watts into joules between flushes."""

    def __init__(self) -> None:
        self.joules = {port: 0.0 for port in PORTS}
        self.last_w: dict[str, float] = {}
        self.last_t: float | None = None

    def reading(self, values: dict) -> None:
        now = time.time()
        watts = {
            port: float(values[f"{port}_power"])
            for port in PORTS
            if f"{port}_power" in values
        }
        if not watts:
            return
        if self.last_t is not None and now - self.last_t <= MAX_SAMPLE_GAP:
            elapsed = now - self.last_t
            for port, w in self.last_w.items():
                self.joules[port] += w * elapsed
        self.last_w.update(watts)
        self.last_t = now

    def flush(self, elapsed: float) -> dict[str, float]:
        """Return average watts per port over `elapsed` and reset."""
        avg = {port: j / elapsed for port, j in self.joules.items()}
        self.joules = {port: 0.0 for port in PORTS}
        return avg


async def record(args: argparse.Namespace, password: str) -> None:
    from aiohttp import ClientSession
    from anker_solix_api.api import AnkerSolixApi
    from anker_solix_api.mqtt_factory import SolixMqttDeviceFactory

    log = logging.getLogger("anker")
    async with ClientSession() as web:
        api = AnkerSolixApi(args.username, password, args.country, web, log)
        await api.apisession.async_authenticate()
        await api.update_sites()
        await api.get_bind_devices()
        sn = next(
            (s for s, d in api.devices.items() if d.get("device_pn") == MODEL),
            None,
        )
        if sn is None:
            raise RuntimeError(
                f"no {MODEL} on this account (standalone devices are only "
                "visible to the owner account, and it must be on Wi-Fi)"
            )
        log.info("found %s (%s)", MODEL, sn)

        mqtt = await api.startMqttSession()
        topics = {f"{mqtt.get_topic_prefix(deviceDict=api.devices[sn])}#"}
        meter = PortMeter()

        def on_msg(session, topic, message, data, model, device_sn, values):
            if device_sn == sn and values:
                meter.reading(values)

        poller = asyncio.create_task(mqtt.message_poller(
            topics=topics, trigger_devices={sn}, msg_callback=on_msg,
            timeout=TRIGGER_SECONDS,
        ))

        # The poller's periodic request yields 0a00 snapshots; the 1 Hz 0303
        # stream needs the realtime trigger, re-sent before the device's
        # streaming window lapses.
        device = SolixMqttDeviceFactory(api, sn).create_device()
        last_flush = time.time()
        last_publish = 0.0
        while not poller.done():
            try:
                await device.realtime_trigger(timeout=TRIGGER_SECONDS * 5)
            except Exception as error:
                log.warning("realtime trigger failed: %s", error)
            await asyncio.sleep(min(FLUSH_SECONDS, TRIGGER_SECONDS))

            now = time.time()
            if now - last_flush >= FLUSH_SECONDS:
                ts = datetime.datetime.now().astimezone()
                elapsed = now - last_flush
                avg = meter.flush(elapsed)
                if any(avg.values()):
                    append_row(
                        args.state_dir / "samples" / f"{ts:%Y-%m}.csv",
                        "timestamp,elapsed_s," + ",".join(f"{p}_w" for p in PORTS),
                        f"{ts.isoformat(timespec='seconds')},{elapsed:.1f},"
                        + ",".join(f"{avg[p]:.3f}" for p in PORTS),
                    )
                last_flush = now
            if now - last_publish >= PUBLISH_SECONDS:
                try:
                    publish(args.state_dir, args.device_out,
                            args.name, args.overlaps_with)
                except Exception:
                    log.exception("publish failed; next cycle retries")
                last_publish = now
        poller.result()  # surface the poller's exception


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--username", required=True, help="Anker account email")
    parser.add_argument("--country", default="US", help="2-letter country code")
    parser.add_argument("--name", default="Anker charger",
                        help="device name in the dashboard")
    parser.add_argument("--overlaps-with", action="append", default=[],
                        help="dashboard device that may draw through this "
                             "charger (repeatable), e.g. the Mac recorder's name")
    parser.add_argument("--device-out", type=pathlib.Path,
                        help="device JSON to publish")
    parser.add_argument("--state-dir", type=pathlib.Path,
                        default=pathlib.Path.home()
                        / ".local/share/energy-dashboard/anker-power",
                        help="where the sample CSVs accumulate")
    parser.add_argument("--login", action="store_true",
                        help="prompt for the password, store it in the "
                             "keychain, and exit")
    args = parser.parse_args()

    if args.login:
        keychain_set(args.username, getpass.getpass("Anker account password: "))
        print("saved to the keychain")
        return
    if args.device_out is None:
        parser.error("--device-out is required")
    password = keychain_get(args.username)
    if not password:
        raise SystemExit("no password in the keychain — run with --login first")

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    while True:  # token expiry, network loss, cloud hiccups: rebuild and go on
        try:
            asyncio.run(record(args, password))
        except Exception:
            logging.getLogger("anker").exception("session died; retrying in 60s")
        time.sleep(60)


if __name__ == "__main__":
    main()
