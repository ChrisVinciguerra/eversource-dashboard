"""Fetching usage data and writing the CSV export folders.

Only the most granular data (15-min reads) is fetched from Opower; hourly and
daily are aggregated from it locally (verified to match the API's own hourly /
daily exports exactly). Billed monthly usage and bills are fetched separately
because they carry costs and temperatures not derivable from meter reads.
"""

from __future__ import annotations

import io
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from .client import BILLS_QUERY, READS_QUERY, Client
from .config import (
    EXPORT_FIRST_HINT,
    EXPORT_GLOB,
    EXPORT_ROOT,
    TZ,
    CliError,
    Config,
    Json,
    NoExports,
    today,
)
from .data import DATASET_KEYS
from .progress import emit

# Days of 15-min reads to request per GraphQL call.
CHUNK_DAYS = 3

# Months of billed history to request when the exported range is shorter.
MONTHLY_MIN_MONTHS = 36
BILLS_MIN_MONTHS = 13

# Columns pulled out of each raw API payload, in CSV order.
MONTHLY_API_COLUMNS = [
    "meter",
    "year",
    "month",
    "usageEndDate",
    "numberOfDays",
    "usageConsumption",
    "unitOfMeasure",
    "usageCharge",
    "usagePerDay",
    "chargePerDay",
    "averageDailyTemperature",
]
BILL_SEGMENT_COLUMNS = [
    "usageInterval",
    "serviceAgreement.serviceType",
    "serviceQuantities",
    "usageCharges.value",
    "currentAmount.value",
    "estimated",
]
READ_COLUMNS = [
    "meter",
    "stream",
    "timeInterval",
    "measuredAmount.value",
    "measuredAmount.unit",
    "stream_unit",
    "readType",
]


def write_csv(frame: pd.DataFrame, path: Path) -> None:
    """Write a dataframe to CSV and report the row count."""
    frame.to_csv(path, index=False)
    emit(f"wrote {len(frame)} rows -> {path}")


def iso(day: date) -> str:
    """Return the local-midnight ISO timestamp for a date."""
    return datetime(day.year, day.month, day.day, tzinfo=TZ).isoformat()


def interval_bounds(intervals: pd.Series) -> tuple[pd.Series, pd.Series]:
    """Split a 'start/end' ISO interval column into (start, end) Series."""
    parts = intervals.str.split("/", expand=True)
    return parts[0], parts[1]


def months_of_history(start: date, minimum: int) -> int:
    """Return the months of billed history needed to reach back to `start`."""
    now = today()
    span = (now.year - start.year) * 12 + now.month - start.month + 1
    return max(minimum, span)


def fetch_monthly(
    client: Client, account: Json, months: int = MONTHLY_MIN_MONTHS
) -> pd.DataFrame:
    """Return billed monthly usage, charges and temperatures (Eversource API)."""
    web_id = client.accounts()["webId"]
    frames = []
    # While Eversource billing is down, meters and usageDetails are both null.
    for meter in account["serviceMeterDetails"] or []:
        service_type = "electric" if meter["metertype"] == "E" else "gas"
        data = client.es_get(
            "/billing/api/usage/usage"
            f"?webId={web_id}&billingAccount={account['billingAccountIdentifier']}"
            f"&sourceDomain={account['sourceDomain']}"
            f"&serviceAccount={meter['serviceaccountid']}"
            f"&serviceType={service_type}&meterNumber={meter['meternumber']}"
            f"&monthOfData={months}"
        )
        usage = pd.json_normalize(data.get("usageDetails") or [])
        frames.append(usage.assign(meter=meter["meternumber"]))
    if not frames:
        return pd.DataFrame(columns=MONTHLY_API_COLUMNS)
    raw = pd.concat(frames, ignore_index=True).reindex(columns=MONTHLY_API_COLUMNS)
    if raw.empty:
        return raw
    return pd.DataFrame(
        {
            "billing_account": account["billingAccountIdentifier"],
            "meter": raw["meter"],
            "year": raw["year"],
            "month": raw["month"],
            "period_end": raw["usageEndDate"].str[:10],
            "days": raw["numberOfDays"],
            "usage": raw["usageConsumption"],
            "unit": raw["unitOfMeasure"],
            "charge_usd": raw["usageCharge"],
            "usage_per_day": raw["usagePerDay"],
            "charge_per_day": raw["chargePerDay"],
            "avg_daily_temp_f": raw["averageDailyTemperature"],
        }
    )


def fetch_bills(
    client: Client, account: Json, months: int = BILLS_MIN_MONTHS
) -> pd.DataFrame:
    """Return billed cost and usage per service agreement (Opower GraphQL)."""
    billing_account = str(account["billingAccountIdentifier"])
    meta = client.metadata(billing_account)
    end = datetime.now(TZ)
    start = end - timedelta(days=int(months * 30.5) + 15)
    data = client.gql(
        billing_account,
        "WDB_GetCostUsageReadsForBills",
        BILLS_QUERY,
        {
            "selectedAccount": meta["selectedAccount"],
            "last": months + 1,
            "timeInterval": f"{start.isoformat()}/{end.isoformat()}",
            "forceLegacyData": False,
            "aliased": True,
        },
    )
    segments = pd.json_normalize(
        data["billingAccountByAuthContext"]["bills"], record_path="segments"
    ).reindex(columns=BILL_SEGMENT_COLUMNS)
    if segments.empty:
        return segments
    period_start, period_end = interval_bounds(segments["usageInterval"])
    # First reported service quantity per segment (usage amount + unit), if any.
    quantity = segments["serviceQuantities"].str[0]
    return pd.DataFrame(
        {
            "billing_account": billing_account,
            "service_type": segments["serviceAgreement.serviceType"],
            "period_start": period_start.str[:10],
            "period_end": period_end.str[:10],
            "usage": quantity.str["serviceQuantity"].str["value"],
            "unit": quantity.str["unit"],
            "usage_charges_usd": segments["usageCharges.value"],
            "total_amount_usd": segments["currentAmount.value"],
            "estimated": segments["estimated"],
        }
    )


def fetch_quarter_hour(
    client: Client, account: Json, start: date, end: date
) -> pd.DataFrame:
    """Return deduplicated 15-min interval reads (Opower GraphQL)."""
    billing_account = str(account["billingAccountIdentifier"])
    meta = client.metadata(billing_account)

    # Flatten every GraphQL response into one list of read records, tagged with
    # the meter and stream they came from; pandas does the rest.
    reads: list[Json] = []
    chunk = timedelta(days=CHUNK_DAYS)
    for meter in meta["meters"]:
        current = start
        while current <= end:
            chunk_end = min(current + chunk, end + timedelta(days=1))
            emit(f"fetching 15-min reads {current} .. {chunk_end} ...")
            data = client.gql(
                billing_account,
                "WDB_GetUsageReadsForDayAndHourWithIntervalReads",
                READS_QUERY,
                {
                    "selectedAccount": meta["selectedAccount"],
                    "timeInterval": f"{iso(current)}/{iso(chunk_end)}",
                    "resolution": "QUARTER_HOUR",
                    "saUuid": meter["saUuid"],
                    "spUuid": meter["spUuid"],
                    "forceLegacyData": False,
                    "aliased": True,
                },
            )
            agreements = data["billingAccountByAuthContext"][
                "serviceAgreementsConnection"
            ]["edges"]
            for agreement in agreements:
                for point in agreement["node"]["servicePointsConnection"]["edges"]:
                    streams = point["node"]["readStreams"] or {}
                    for name in ("netUsage", "energyDelivered", "energyReceived"):
                        for stream in streams.get(name) or []:
                            reads.extend(
                                {
                                    "meter": meter["utilityId"],
                                    "stream": name,
                                    "stream_unit": stream.get("unit"),
                                    **read,
                                }
                                for read in stream["reads"]
                            )
            current = chunk_end

    if not reads:
        return pd.DataFrame()
    raw = pd.json_normalize(reads).reindex(columns=READ_COLUMNS)
    read_start, read_end = interval_bounds(raw["timeInterval"])
    out = pd.DataFrame(
        {
            "billing_account": billing_account,
            "meter": raw["meter"],
            "stream": raw["stream"],
            "start": read_start,
            "end": read_end,
            "value": raw["measuredAmount.value"],
            "unit": raw["measuredAmount.unit"].fillna(raw["stream_unit"]),
            "read_type": raw["readType"],
        }
    )
    # The API treats the chunk end date as inclusive, so chunk-boundary days
    # come back twice — drop the repeats.
    return out.drop_duplicates(subset=["meter", "stream", "start"], ignore_index=True)


def aggregate(quarter: pd.DataFrame, freq: str) -> pd.DataFrame:
    """Sum 15-min reads into hourly ('h') or daily ('D') buckets, local time."""
    ts = pd.to_datetime(quarter["start"], utc=True)
    # Floor hours in UTC and days via normalize(): flooring local wall times
    # raises on the repeated 1am hour of a DST fall-back day. Hour boundaries
    # match in UTC and local time; local midnight is never ambiguous.
    bucket = (
        ts.dt.floor(freq).dt.tz_convert(TZ)
        if freq == "h"
        else (ts.dt.tz_convert(TZ).dt.normalize())
    )
    out = (
        quarter.assign(start=bucket)
        .groupby(["billing_account", "meter", "stream", "start"], as_index=False)
        .agg(value=("value", "sum"), unit=("unit", "first"))
    )
    out.insert(4, "end", out["start"] + pd.tseries.frequencies.to_offset(freq))
    for col in ("start", "end"):
        out[col] = out[col].map(lambda ts: ts.isoformat())
    return out


def fetch_datasets(
    client: Client, account: Json, start: date, end: date
) -> dict[str, pd.DataFrame]:
    """Fetch every dataset for a date range, keyed by CSV name."""
    quarter = fetch_quarter_hour(client, account, start, end)
    if quarter.empty:
        raise CliError("no interval reads returned for the requested range")
    frames = {
        "quarter_hour": quarter,
        "hourly": aggregate(quarter, "h"),
        "daily": aggregate(quarter, "D"),
    }
    # Billed data is requested as "N months back from today", so a long
    # --start has to widen N or the CSVs silently stop short of it.
    for name, fetch, minimum in (
        ("monthly", fetch_monthly, MONTHLY_MIN_MONTHS),
        ("bills", fetch_bills, BILLS_MIN_MONTHS),
    ):
        frame = fetch(client, account, months_of_history(start, minimum))
        if frame.empty:
            emit(f"note: no {name} data returned; skipped")
        else:
            frames[name] = frame
    return frames


def write_export(frames: dict[str, pd.DataFrame], output: str | None) -> Path:
    """Write the datasets to a new export folder, one CSV each."""
    out_dir = Path(
        output or EXPORT_ROOT / f"eversource_export_{datetime.now(TZ):%Y-%m-%d_%H%M%S}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, frame in frames.items():
        write_csv(frame, out_dir / f"{name}.csv")
    emit(f"export complete -> {out_dir}/")
    return out_dir


def run_export(
    cfg: Config,
    account_number: str | None,
    start: date,
    end: date,
    output: str | None,
) -> Path:
    """Fetch every dataset for a date range and write the CSV folder."""
    with Client(cfg) as client:
        account = client.pick_account(account_number)
        if start > end:
            raise CliError("--start is after --end")
        frames = fetch_datasets(client, account, start, end)
    return write_export(frames, output)


def _csv_rows(source: Path | io.StringIO) -> pd.DataFrame:
    """Read a CSV as its literal text, so rows compare exactly as written."""
    return pd.read_csv(source, dtype=str, keep_default_na=False)


def rows_not_exported(name: str, frame: pd.DataFrame) -> pd.DataFrame:
    """Return the rows of `frame` that the export folders don't already hold.

    A row counts as held only when the merged exports (newest folder winning)
    carry it with every value the same, so a revised read is new too.
    """
    keys = DATASET_KEYS[name]
    new = _csv_rows(io.StringIO(frame.to_csv(index=False)))
    folders = sorted(p for p in EXPORT_ROOT.glob(EXPORT_GLOB) if p.is_dir())
    olds = [
        _csv_rows(folder / f"{name}.csv")
        for folder in reversed(folders)  # newest first + keep="first" wins
        if (folder / f"{name}.csv").is_file()
    ]
    if not olds:
        return frame
    old = pd.concat(olds, ignore_index=True).drop_duplicates(subset=keys, keep="first")
    if set(new.columns) - set(old.columns):
        return frame
    held = set(old[list(new.columns)].itertuples(index=False, name=None))
    missing = [row not in held for row in new.itertuples(index=False, name=None)]
    return frame[missing]


def latest_exported_day() -> date:
    """Return the most recent 15-min read date across all exports/ folders."""
    csvs = [
        folder / "quarter_hour.csv"
        for folder in EXPORT_ROOT.glob(EXPORT_GLOB)
        if (folder / "quarter_hour.csv").is_file()
    ]
    if not csvs:
        raise NoExports(
            f"no existing exports found in {EXPORT_ROOT}/; {EXPORT_FIRST_HINT}"
        )
    latest = max(pd.read_csv(csv, usecols=["start"])["start"].max() for csv in csvs)
    return date.fromisoformat(latest[:10])


def run_update(
    cfg: Config, account_number: str | None, output: str | None
) -> Path | None:
    """Export from the latest already-exported day through today.

    The latest exported day may have been partial, so it is re-fetched; the
    merge step dedups the overlap, newest export winning. Reads post in
    blocks hours apart, so most pulls find nothing: only the datasets that
    differ from what is already exported are written, and when none do no
    folder is made and None is returned.
    """
    start = latest_exported_day()
    emit(f"updating from {start} to today")
    with Client(cfg) as client:
        account = client.pick_account(account_number)
        frames = fetch_datasets(client, account, start, today())

    fresh = {name: rows_not_exported(name, frame) for name, frame in frames.items()}
    changed = {name: frames[name] for name, rows in fresh.items() if not rows.empty}
    quarter = frames["quarter_hour"]
    posted = pd.to_datetime(quarter["end"], utc=True).max().tz_convert(TZ)
    through = f"{posted:%b} {posted.day}, {posted:%I:%M %p}".replace(", 0", ", ")
    if not changed:
        emit(f"nothing new: Eversource has posted reads through {through}")
        return None
    out_dir = write_export(changed, output)
    reads = fresh["quarter_hour"]["start"].nunique()
    if reads:
        emit(f"{reads} new 15-min reads, through {through}")
    else:
        emit(f"no new reads (still through {through}); updated {', '.join(changed)}")
    return out_dir
