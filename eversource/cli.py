"""Command-line interface.

Commands:
  login       open a browser, sign in (session kept in the profile)
  accounts    list billing accounts and meters
  export      write quarter_hour/hourly/daily/monthly/bills CSVs into a
              timestamped folder under exports/
  update      export from the most recent exported data through today
  serve       run the local dashboard (merges every export folder, updates on
              demand, redesigned web UI)
"""

from __future__ import annotations

import argparse
import sys
from datetime import date

from .client import Client, login
from .config import CliError, Config, load_config
from .fetch import run_export, run_update

ACCOUNT_HELP = "billing account number (default: first)"
EXPORT_OUTPUT_HELP = "output folder (default: exports/eversource_export_<timestamp>)"


def cmd_login(args: argparse.Namespace, cfg: Config) -> None:
    account_info = login(cfg, timeout=args.timeout)
    count = len(account_info["accountSwitcherItems"])
    print(f"signed in — webId {account_info['webId']}, {count} billing account(s).")


def cmd_accounts(args: argparse.Namespace, cfg: Config) -> None:
    with Client(cfg) as client:
        for item in client.accounts()["accountSwitcherItems"]:
            print(
                f"{item['billingAccountIdentifier']}  "
                f"[{item['type']}]  {item['address']}"
            )
            for meter in item["serviceMeterDetails"]:
                print(f"    meter {meter['meternumber']} (type {meter['metertype']})")


def cmd_export(args: argparse.Namespace, cfg: Config) -> None:
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end) if args.end else date.today()
    run_export(cfg, args.account, start, end, args.output)


def cmd_update(args: argparse.Namespace, cfg: Config) -> None:
    run_update(cfg, args.account, args.output)


def cmd_serve(args: argparse.Namespace, cfg: Config) -> None:
    from .web import serve

    serve(port=args.port, open_browser=not args.no_open)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Pull Eversource energy data: CSV exports and a local dashboard. "
            "With no command, runs `serve`."
        )
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    login_cmd = sub.add_parser(
        "login", help="open a browser, sign in, capture the session"
    )
    login_cmd.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="seconds to wait for sign-in to complete (default 300)",
    )
    login_cmd.set_defaults(func=cmd_login)

    accounts = sub.add_parser("accounts", help="list billing accounts and meters")
    accounts.set_defaults(func=cmd_accounts)

    export = sub.add_parser(
        "export",
        help=(
            "export quarter_hour/hourly/daily/monthly/bills CSVs into a "
            "timestamped folder"
        ),
    )
    export.add_argument("--account", help=ACCOUNT_HELP)
    export.add_argument("--start", required=True, help="YYYY-MM-DD")
    export.add_argument("--end", help="YYYY-MM-DD (default: today)")
    export.add_argument("-o", "--output", help=EXPORT_OUTPUT_HELP)
    export.set_defaults(func=cmd_export)

    update = sub.add_parser(
        "update",
        help="export from the most recent exported data through today",
    )
    update.add_argument("--account", help=ACCOUNT_HELP)
    update.add_argument("-o", "--output", help=EXPORT_OUTPUT_HELP)
    update.set_defaults(func=cmd_update)

    serve_cmd = sub.add_parser(
        "serve",
        help="run the local dashboard web app (the default command)",
    )
    serve_cmd.add_argument(
        "--port", type=int, default=8537, help="port to listen on (default 8537)"
    )
    serve_cmd.add_argument(
        "--no-open", action="store_true", help="don't open the browser"
    )
    serve_cmd.set_defaults(func=cmd_serve)

    return parser


def main() -> None:
    # No command means the dashboard: `uv run eversource.py` just serves.
    argv = sys.argv[1:] or ["serve"]
    args = build_parser().parse_args(argv)
    try:
        args.func(args, load_config())
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
