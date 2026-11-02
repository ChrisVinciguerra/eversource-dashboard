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

## Overlapping devices (double-count protection)

When one metered device sometimes powers another (a laptop charging from a
metered charging station), excluding both would subtract that energy twice.
The powering device can carry a per-port breakdown and name the devices that
may draw through it:

```json
{
  "name": "Anker charger",
  "overlaps_with": ["My MacBook"],
  "readings": {
    "start": "…", "end": "…",
    "values_kwh": { "…": 0.01 },
    "ports": { "USB-C 1": { "…": 0.0075 }, "USB-A": { "…": 0.0025 } }
  }
}
```

For each 15-minute slot both devices cover, a port whose energy matches the
other device's reading (within 30%, to absorb sampling skew and conversion
loss) is treated as the same energy metered twice; the dashboard subtracts it
once when both chips are active. Slots where the laptop charged from a
different outlet match no port, so both subtract in full.

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

## Recording an Anker Prime charging station (A91B2)

`scripts/anker_power_recorder.py` reads the per-port power an Anker Prime
240W charging station (model A91B2) streams over Anker's cloud MQTT — there
is no local API — and publishes it here with the per-port breakdown and an
`overlaps_with` naming the Mac, so a laptop charging through it isn't counted
twice (see above). Install it with:

```sh
scripts/install_anker_power_agent.sh you@example.com "Anker charger" "My MacBook"
```

The account must be the one that *owns* the charger (not a shared member),
and the charger must be on Wi-Fi. The password is stored in the macOS
keychain. Caveats: the two AC outlets are switched but not metered (only the
4 USB-C + 2 USB-A ports report power), and nothing records while the Mac
running the agent sleeps.
