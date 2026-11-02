"""Shared constants, error types, and config persistence.

Config (session cookies, Okta tokens, cached JWT, account metadata, Opower
uuids) lives in ~/.config/eversource-cli/config.json (mode 0600). The account
password is never stored there — it goes in the system keychain, see auth.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

CONFIG_DIR = Path.home() / ".config" / "eversource-cli"
CONFIG_PATH = CONFIG_DIR / "config.json"
TZ = ZoneInfo("America/New_York")
ES = "https://www.eversource.com"
LOGIN_URL = f"{ES}/security/account/login"
MSLOGIN_URL = f"{ES}/security/account/MSLogin"
MFALOGIN_URL = f"{ES}/security/account/MFALogin"
MSLOGIN_RETURN_URL = "/cg/customer/accountoverview"
ACCOUNT_URL = f"{ES}/cg/customer/Account"
OPOWER_GQL = "https://ever.opower.com/ei/edge/apis/dsm-graphql-v1/cws/graphql"

# Okta (Classic Engine) org backing the Eversource sign-in page. The site's SPA
# signs in with /api/v1/authn and then exchanges the resulting one-shot
# sessionToken for tokens over PKCE; auth.py replays exactly that.
OKTA = "https://eversource-external.okta.com"
OKTA_ISSUER = f"{OKTA}/oauth2/ausrjxam6icWYMIj41t7"
OKTA_CLIENT_ID = "0oarjx5m8i3r1586a1t7"
OKTA_REDIRECT_URI = f"{ES}/security/account/Login"
# offline_access buys a refresh token, so an expired access token can be
# renewed without the password (and without re-triggering MFA).
OKTA_SCOPES = "openid profile email offline_access"

# Service name for the keychain entry holding the account password.
KEYCHAIN_SERVICE = "eversource-cli"

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

# Config keys: "username" (str), "cookies" (list[Cookie]), "okta" (OktaTokens),
# "okta_dt" (str: device-trust cookie that suppresses MFA), "accounts" (Json),
# "jwt" (dict[str, JwtCache]), "opower_meta" (dict[str, Json]).
Config = dict[str, Any]


class CliError(Exception):
    """A user-facing failure: printed without a traceback by the CLI."""


class SessionExpired(CliError):
    """No usable session, and it could not be renewed without the password."""


class MfaRequired(CliError):
    """Okta wants a second factor and no way to ask for the code was given."""


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
