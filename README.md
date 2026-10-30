# eversource-dashboard

Pull your Eversource energy usage data, export it to CSV, and explore it in a
local web dashboard. Reverse-engineered from a browser capture of the
usage-detail page.

> **Unofficial.** This project is not affiliated with or endorsed by Eversource
> or Opower. It automates the same requests your own browser makes while you
> are signed in to your own account, for your own data, on your own machine.
> The APIs are undocumented and may change or break at any time; use at your
> own risk. MIT licensed (see `LICENSE`).

## How it works

1. You sign in through Eversource's **Okta** login
   (`https://www.eversource.com/security/account/login`,
   issuer `eversource-external.okta.com/oauth2/ausrjxam6icWYMIj41t7`,
   client `0oarjx5m8i3r1586a1t7`). The `login` command replays exactly what the
   sign-in page's SPA does, over plain HTTP: `POST /security/account/MSLogin`
   for the Eversource session cookies, then Okta's `/api/v1/authn` for a
   one-shot `sessionToken`, exchanged for tokens over PKCE. No browser is
   involved. Okta's second factor is only asked for once — the device-trust
   cookie it returns is kept and replayed, as the browser would.
2. Eversource's own APIs need those cookies *plus* the Okta access token as an
   `Authorization: Bearer` header. One of those calls,
   `getOpowerWidgetData/{account}`, returns a short-lived (1 hour) Opower JWT,
   which is cached and refreshed automatically.
3. That JWT is used as a Bearer token against Opower's GraphQL API
   (`ever.opower.com`), which serves the interval reads behind the usage charts.

Only the most granular data (15-minute reads) is fetched from Opower; hourly and
daily series are aggregated from it locally in `America/New_York` (verified to
match the API's own hourly/daily exports exactly). Billed monthly usage and bills
are fetched separately because they carry costs and temperatures that aren't
derivable from meter reads.

Sessions renew themselves. The access token is refreshed with the OAuth refresh
token; if that is gone too, the saved password is used to sign in again from
scratch. Either way it happens mid-request, so expiry is invisible — the
`login` command and the dashboard's sign-in button exist for the first run.

Config (session cookies, Okta tokens, the device-trust cookie, cached JWT,
account metadata, Opower service agreement/service point uuids) lives in
`~/.config/eversource-cli/config.json` (mode 0600). The password is **not** kept
there — it goes in the macOS keychain under the service `eversource-cli`.

## Layout

- `eversource.py` — thin entry-point shim for the CLI
- `eversource/` — the package
  - `config.py` — constants, error types, config persistence
  - `auth.py` — the browserless sign-in flow and credential storage
  - `client.py` — authenticated Eversource/Opower client
  - `fetch.py` — fetching reads/bills and writing export folders
  - `data.py` — merging export folders and shaping the dashboard payload
  - `cli.py` — the command-line interface
  - `web/` — FastAPI app (`app.py`) and the static dashboard page (`static/`)

## Setup

This is a `uv` project. Install dependencies once:

```sh
uv sync
```

Then sign in:

```sh
uv run eversource.py login            # or: login <email-or-username>
```

It asks for your password, and for a verification code if Okta wants one. The
password is saved to the keychain and the device is remembered, so this is a
one-time step: from then on the session renews itself silently and you should
never be asked again. `uv run eversource.py logout` undoes it.

## The dashboard

```sh
uv run eversource.py          # `serve` is the default command
```

Starts a local web app (default `http://127.0.0.1:8537/`) and opens it. The page
merges every `exports/eversource_export_*` folder into one continuous span
(newest export wins on overlapping rows) and shows:

- summary tiles (latest day, last 7 days, estimated 30-day cost, latest bill)
- daily / hourly / 15-minute usage with a Usage/Cost toggle, quick-range
  presets, and a zoomable range slider
- billed monthly usage and charges, and the bills history
- a table view behind every chart

On open, if the data doesn't reach today, it kicks off an update automatically
and re-renders when it finishes. An expired session is renewed in the
background without interrupting you; the page only asks for a password if
there isn't one saved yet.
Light and dark themes follow the OS (toggleable in the header).
`--port` picks the port; `--no-open` skips launching the browser.

For a double-clickable launcher, `scripts/make_desktop_app.sh` creates
`~/Desktop/Energy.app` (icon in `assets/`): it starts the dashboard, or just
opens the browser if the server is already running.

## CLI usage

```sh
uv run eversource.py accounts                       # list billing accounts and meters
uv run eversource.py export --start 2026-01-01      # export a date range -> exports/<timestamp>/
uv run eversource.py export --start 2026-10-01 --end 2026-10-14
uv run eversource.py update                         # extend from the last exported day to today
uv run eversource.py serve                          # local dashboard
```

- **`export`** — `--start YYYY-MM-DD` (required), `--end YYYY-MM-DD` (default:
  today), `--account <billing account #>` (default: first account),
  `-o/--output <folder>` (default:
  `exports/eversource_export_<YYYY-MM-DD_HHMMSS>`). Writes
  `quarter_hour.csv`, `hourly.csv`, `daily.csv`, plus `monthly.csv` and
  `bills.csv`. The billed data is requested as a whole number of months back
  from today — at least 36 for monthly and 13 for bills, widened automatically
  when `--start` reaches further back than that.
- **`update`** — finds the most recent 15-minute read across every
  `exports/eversource_export_*` folder and re-exports from that day through
  today (the last day may have been partial, so it is re-fetched). Takes
  `--account` and `-o/--output`.

`exports/` is resolved beside the package (the repo root), so every command and
the dashboard find the same export folders no matter which directory they run
from.

### Output columns

- **quarter_hour.csv** — `billing_account, meter, stream, start, end, value,
  unit, read_type` (stream is `netUsage`; `energyDelivered`/`energyReceived`
  appear for solar)
- **hourly.csv / daily.csv** — same minus `read_type`: `billing_account, meter,
  stream, start, end, value, unit`
- **monthly.csv** — `billing_account, meter, year, month, period_end, days,
  usage, unit, charge_usd, usage_per_day, charge_per_day, avg_daily_temp_f`
- **bills.csv** — `billing_account, service_type, period_start, period_end,
  usage, unit, usage_charges_usd, total_amount_usd, estimated`

## Notes / caveats

- 15-minute reads are fetched in `CHUNK_DAYS` = 3 day chunks per meter, close to
  what the website itself requests. The API treats the chunk end date as
  inclusive, so boundary days repeat; duplicates are dropped on
  `(meter, stream, start)`.
- The dashboard's cost series is derived, not billed: each read's usage is
  multiplied by the effective rate of the billing period containing it (total
  bill ÷ billed usage, so fixed charges are spread across the period). Reads
  newer than the latest bill use that bill's rate.
- When net usage is present, the dashboard hides the `energyDelivered` /
  `energyReceived` streams, since delivered mirrors net usage unless energy flows
  back to the grid.
- `monthly.csv` / `bills.csv` are skipped with a note if the API returns nothing;
  `export` exits with an error if no interval reads come back at all.
- The GraphQL queries this tool uses are embedded in `eversource/client.py`. The
  site makes other calls it does not use (weather, disaggregation, rates,
  solar); recovering those means re-capturing a HAR from DevTools while signed
  in and pulling the operations out of it.
- The web server binds to 127.0.0.1 only and has no authentication of its own —
  it is meant for your own machine, not for exposing on a network.
