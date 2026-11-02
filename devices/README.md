# Known devices

One JSON file per device. The dashboard shows a filter chip per device
("− Fridge") that virtually subtracts its usage — and its cost, at the billing
period's effective rate — from the interval charts, the usage table, and the
summary tiles.

Device files are **gitignored** (they describe your home and may embed private
hostnames); this README documents the format.

## Document format

```json
{
  "name": "Garage freezer",
  "readings": {
    "start": "2026-05-04T16:00",
    "end": "2026-11-01T20:45",
    "values_kwh": { "2026-11-01T16:00": 0.0123, "2026-11-01T16:15": 0.0119 }
  },
  "pattern": { "values_kwh": [0.01, 0.02] }
}
```

At least one of `readings` / `pattern` must be present:

- **`readings`** — the device's *actual metered usage*: kWh per 15-minute slot,
  keyed by the slot's local start time (`YYYY-MM-DDTHH:MM`). Slots where the
  device drew nothing may be omitted — inside the `start`/`end` coverage
  window, a missing slot means zero.
- **`pattern`** — a *repeating estimate* used outside the readings window (or
  always, if there are no readings): kWh per 15-minute slot, repeating
  indefinitely, aligned to local midnight. A 96-entry list describes one full
  day; a hand-written `[0.01, 0.02]` describes a half-hour cycle.

A minimal hand-written device is just:

```json
{ "name": "Fridge", "pattern": { "values_kwh": [0.001, 0, 0, 0.012] } }
```

## Remote sources (self-measuring devices)

A file may instead point at a machine that measures itself and publishes the
document above:

```json
{ "source": "myserver:/var/lib/power/device.json" }
```

`source` is a local path, an ssh `host:path`, or an `http(s)://` URL. The
dashboard re-pulls
every source each time the page is opened and writes the fetched document back
into this file, so it doubles as a cache — an unreachable source (host asleep,
network down) keeps serving the last successful fetch.

## Recording this Mac

`scripts/mac_power_recorder.py` turns the Mac it runs on into such a device
(Apple Silicon): it samples the wall input power from the battery telemetry,
estimates charging that happened while asleep from the battery charge delta,
and publishes a device file here. Install it as a launchd agent with:

```sh
scripts/install_mac_power_agent.sh "My MacBook" macbook.json
```
