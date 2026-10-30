"""Shared constants, error types, and config persistence.

Config (session cookies, cached JWT, account metadata, Opower uuids) lives in
~/.config/eversource-cli/config.json (mode 0600). The persistent browser
profile (so MFA "remember this device" survives between logins) lives next to
it in browser-profile/.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

CONFIG_DIR = Path.home() / ".config" / "eversource-cli"
CONFIG_PATH = CONFIG_DIR / "config.json"
BROWSER_PROFILE = CONFIG_DIR / "browser-profile"  # persists MFA "remember device"
TZ = ZoneInfo("America/New_York")
ES = "https://www.eversource.com"
LOGIN_URL = f"{ES}/security/account/login"
ACCOUNT_URL = f"{ES}/cg/customer/Account"
OPOWER_GQL = "https://ever.opower.com/ei/edge/apis/dsm-graphql-v1/cws/graphql"

# Timestamped export folders live beside the package (the repo root), so
# `update` and `serve` find earlier exports no matter the working directory.
EXPORT_ROOT = Path(__file__).resolve().parent.parent / "exports"
EXPORT_GLOB = "eversource_export_*"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
)

RELOGIN_HINT = "Run: eversource.py login"
EXPORT_FIRST_HINT = "run `eversource.py export` first"

Json = dict[str, Any]
Cookie = dict[str, Any]

# Config keys: "cookies" (list[Cookie]), "accounts" (Json), "jwt"
# (dict[str, JwtCache]), "opower_meta" (dict[str, Json]), plus the legacy
# "cookie" header string written by older versions.
Config = dict[str, Any]


class CliError(Exception):
    """A user-facing failure: printed without a traceback by the CLI."""


class SessionExpired(CliError):
    """The saved Eversource session is missing or no longer valid."""


class NoExports(CliError):
    """No export folders exist yet to merge or extend."""


def load_config() -> Config:
    """Return the saved config, or an empty one if none has been written yet."""
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    return {}


def save_config(cfg: Config) -> None:
    """Write the config back, chmod 0600 (it holds session cookies)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    CONFIG_PATH.chmod(0o600)
