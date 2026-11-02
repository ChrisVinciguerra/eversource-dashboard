"""Sign-in, over plain HTTP — no browser, no Playwright.

This replays exactly what the sign-in page's SPA does:

  1. GET  /security/account/login     antiforgery cookie + the page's formToken
  2. POST /security/account/MSLogin   the ASP.NET session (.TOKENCOOKIE etc.)
  3. POST okta /api/v1/authn          credentials -> one-shot sessionToken
  4. GET  okta /v1/authorize          sessionToken -> authorization code (PKCE)
  5. POST okta /v1/token              code -> access token (+ refresh token)

Steps 1-2 give the cookies and 3-5 the Okta access token; Eversource's own APIs
need both. Okta's second factor is skipped whenever the device-trust cookie
(DT) from an earlier login is presented, so MFA is normally a one-time cost.

The password lives in the system keychain rather than config.json, so that
expired sessions can be renewed with no interaction at all.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
import secrets
import subprocess
import time
import urllib.parse
from collections.abc import Callable
from typing import TypedDict

import requests

from .config import (
    ES,
    KEYCHAIN_SERVICE,
    LOGIN_URL,
    MFALOGIN_URL,
    MSLOGIN_URL,
    MSLOGIN_RETURN_URL,
    OKTA,
    OKTA_CLIENT_ID,
    OKTA_ISSUER,
    OKTA_REDIRECT_URI,
    OKTA_SCOPES,
    UA,
    CliError,
    Config,
    MfaRequired,
    SessionExpired,
    save_config,
)
from .progress import emit

# How the browser labels itself when calling the JSON APIs. Eversource's
# endpoints are ordinary ASP.NET routes, but they do expect the XHR-ish Accept
# and a same-origin Referer.
API_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": f"{ES}/cg/customer/Account",
    "Origin": ES,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

# Ask for the code this far before the access token actually lapses.
EXPIRY_SKEW = 120

MfaPrompt = Callable[[str], str]


class OktaTokens(TypedDict, total=False):
    """Okta access token, its expiry (epoch seconds), and a refresh token."""

    access_token: str
    exp: int
    refresh_token: str


# ------------------------------------------------------------- credentials --


def keychain_get(username: str) -> str | None:
    """Return the stored password for `username`, or None if there isn't one."""
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
    """Store (or replace) the password for `username` in the keychain."""
    try:
        subprocess.run(
            ["security", "add-generic-password", "-U",
             "-s", KEYCHAIN_SERVICE, "-a", username, "-w", password],
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        emit("no `security` command — password not saved; logins will prompt.")
    except subprocess.CalledProcessError as error:
        emit(f"could not save the password to the keychain: {error.stderr.strip()}")


def keychain_delete(username: str) -> None:
    """Remove the stored password, ignoring the case where there isn't one."""
    with_args = ["security", "delete-generic-password",
                 "-s", KEYCHAIN_SERVICE, "-a", username]
    subprocess.run(with_args, capture_output=True, text=True, check=False)


def credentials(cfg: Config) -> tuple[str, str] | None:
    """Return the saved (username, password), if both are available."""
    username = cfg.get("username")
    if not username:
        return None
    password = keychain_get(username)
    return (username, password) if password else None


# ----------------------------------------------------------------- helpers --


def new_session() -> requests.Session:
    """A requests session that presents itself the way the site's SPA does."""
    session = requests.Session()
    session.headers["User-Agent"] = UA
    return session


def eversource_cookies(session: requests.Session) -> list[dict]:
    """The session's eversource.com cookies, in a JSON-friendly shape."""
    return [
        {
            "name": cookie.name,
            "value": cookie.value,
            "domain": cookie.domain,
            "path": cookie.path or "/",
            "secure": bool(cookie.secure),
        }
        for cookie in session.cookies
        if cookie.domain.lstrip(".").endswith("eversource.com")
    ]


def load_cookies(session: requests.Session, cfg: Config) -> requests.Session:
    """Put the saved cookies back into a fresh session."""
    for cookie in cfg.get("cookies", []):
        session.cookies.set(
            cookie["name"], cookie["value"],
            domain=cookie.get("domain", ".eversource.com"),
            path=cookie.get("path", "/"),
        )
    return session


def _token_expiry(token: str, fallback: int) -> int:
    """Read `exp` out of a JWT access token, falling back to expires_in."""
    try:
        claims = token.split(".")[1]
        padded = claims + "=" * (-len(claims) % 4)
        return int(json.loads(base64.urlsafe_b64decode(padded))["exp"])
    except Exception:
        return int(time.time()) + fallback


def _store_tokens(cfg: Config, payload: dict) -> OktaTokens:
    """Normalise an Okta token response into config, keeping any refresh token."""
    tokens: OktaTokens = {
        "access_token": payload["access_token"],
        "exp": _token_expiry(payload["access_token"], payload.get("expires_in", 3600)),
    }
    refresh = payload.get("refresh_token") or cfg.get("okta", {}).get("refresh_token")
    if refresh:
        tokens["refresh_token"] = refresh
    cfg["okta"] = tokens
    return tokens


# -------------------------------------------------------- the login itself --


def _form_token(page_html: str) -> str:
    """Pull the antiforgery token out of the sign-in page's React props."""
    match = re.search(r"formToken&quot;:&quot;([^&]+)&quot;", page_html) or re.search(
        r'"formToken"\s*:\s*"([^"]+)"', html.unescape(page_html)
    )
    if not match:
        raise CliError(
            "could not find the sign-in page's formToken — the page markup has "
            "probably changed and auth.py needs updating."
        )
    return html.unescape(match.group(1))


def _eversource_signin(
    session: requests.Session, username: str, password: str
) -> dict:
    """Steps 1-2: the ASP.NET session cookies Eversource's own APIs require."""
    page = session.get(LOGIN_URL, timeout=30)
    page.raise_for_status()
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Referer": LOGIN_URL,
        "__RequestVerificationToken": _form_token(page.text),
    }
    response = session.post(
        MSLOGIN_URL,
        headers=headers,
        files={
            "WebId": (None, username),
            "Password": (None, password),
            "RememberID": (None, "false"),
            "ReturnUrl": (None, MSLOGIN_RETURN_URL),
            "MfaRememberMeData": (None, ""),
        },
        timeout=60,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("IsSuccess"):
        messages = " ".join(str(v) for v in (body.get("Errors") or {}).values())
        raise CliError(
            "Eversource rejected the sign-in: "
            f"{re.sub(r'<[^>]+>', '', messages).strip() or 'unknown error'}"
        )
    # Since late 2026, MSLogin only validates the credentials; the session
    # cookies (.TOKENCOOKIE etc.) are minted by a second call, MFALogin, keyed
    # on the encrypted user id MSLogin returns as `token`. The site's own MFA
    # wizard between the two is enforced client-side only — Okta's real second
    # factor is still handled in _session_token.
    if body.get("token"):
        finish = session.post(
            MFALOGIN_URL,
            json={
                "WebId": username,
                "Password": password,
                "UserId": body["token"],
                "RememberID": False,
                "ReturnUrl": MSLOGIN_RETURN_URL,
            },
            headers=headers,
            timeout=60,
        )
        finish.raise_for_status()
        if not finish.json().get("IsSuccess"):
            raise CliError(
                "Eversource validated the credentials but refused to finish the "
                "sign-in (MFALogin) — the flow may have changed again."
            )
    return body


def _session_token(
    session: requests.Session,
    cfg: Config,
    username: str,
    password: str,
    mfa_prompt: MfaPrompt | None,
) -> str:
    """Step 3: credentials -> a one-shot Okta sessionToken."""
    cookies = {"DT": cfg["okta_dt"]} if cfg.get("okta_dt") else {}
    response = session.post(
        f"{OKTA}/api/v1/authn",
        json={
            "username": username,
            "password": password,
            "options": {
                "multiOptionalFactorEnroll": False,
                "warnBeforePasswordExpired": False,
            },
        },
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        cookies=cookies,
        timeout=60,
    )
    if response.status_code in (401, 403):
        detail = response.json().get("errorSummary", response.reason)
        raise CliError(f"Okta rejected the credentials: {detail}")
    response.raise_for_status()
    state = response.json()

    if state.get("status") == "MFA_REQUIRED":
        state = _verify_mfa(session, cfg, state, mfa_prompt)
    if state.get("status") == "MFA_ENROLL":
        raise CliError(
            "this account has no usable second factor enrolled — enrol one on "
            "eversource.com, then sign in here again."
        )
    if state.get("status") != "SUCCESS":
        raise CliError(f"unexpected Okta sign-in status: {state.get('status')}")
    return state["sessionToken"]


def _verify_mfa(
    session: requests.Session,
    cfg: Config,
    state: dict,
    mfa_prompt: MfaPrompt | None,
) -> dict:
    """Run one factor to completion and remember the device, so this is rare."""
    factors = state.get("_embedded", {}).get("factors", [])
    order = ("token:software:totp", "email", "sms")
    usable = sorted(
        (f for f in factors if f["factorType"] in order),
        key=lambda f: order.index(f["factorType"]),
    )
    if not usable:
        raise CliError(
            "no supported second factor offered by Okta "
            f"(got {[f['factorType'] for f in factors] or 'none'})."
        )
    factor = usable[0]
    verify_url = factor["_links"]["verify"]["href"]
    state_token = state["stateToken"]

    target = factor.get("profile", {})
    where = target.get("email") or target.get("phoneNumber") or "your device"
    if factor["factorType"] in ("email", "sms"):
        session.post(
            verify_url, json={"stateToken": state_token}, timeout=60
        ).raise_for_status()
        description = f"A verification code was sent to {where}."
    else:
        description = "Enter the code from your authenticator app."

    if mfa_prompt is None:
        raise MfaRequired(description)
    emit(description)

    response = session.post(
        verify_url,
        json={
            "stateToken": state_token,
            "passCode": mfa_prompt(description).strip(),
            "rememberDevice": True,
        },
        timeout=60,
    )
    if response.status_code in (401, 403):
        raise CliError("that verification code was not accepted.")
    response.raise_for_status()

    # Okta hands back a device-trust cookie; keeping it means no MFA next time.
    device_token = next((c.value for c in session.cookies if c.name == "DT"), None)
    if device_token:
        cfg["okta_dt"] = device_token
    return response.json()


def _tokens_from_session_token(
    session: requests.Session, cfg: Config, session_token: str
) -> OktaTokens:
    """Steps 4-5: PKCE exchange. The app only permits `code`, not implicit."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    authorize = session.get(
        f"{OKTA_ISSUER}/v1/authorize",
        params={
            "client_id": OKTA_CLIENT_ID,
            "response_type": "code",
            "response_mode": "query",
            "scope": OKTA_SCOPES,
            "redirect_uri": OKTA_REDIRECT_URI,
            "state": secrets.token_urlsafe(16),
            "nonce": secrets.token_urlsafe(16),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "sessionToken": session_token,
        },
        allow_redirects=False,
        timeout=60,
    )
    location = authorize.headers.get("location", "")
    query = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
    if "code" not in query:
        raise CliError(
            "Okta returned no authorization code "
            f"({query.get('error_description', query.get('error', ['no reason']))[0]})"
        )

    response = session.post(
        f"{OKTA_ISSUER}/v1/token",
        data={
            "grant_type": "authorization_code",
            "client_id": OKTA_CLIENT_ID,
            "redirect_uri": OKTA_REDIRECT_URI,
            "code": query["code"][0],
            "code_verifier": verifier,
        },
        headers={"Accept": "application/json"},
        timeout=60,
    )
    response.raise_for_status()
    return _store_tokens(cfg, response.json())


def login(
    cfg: Config,
    username: str | None = None,
    password: str | None = None,
    mfa_prompt: MfaPrompt | None = None,
    save_password: bool = True,
) -> requests.Session:
    """Sign in and persist the session. Returns the live requests session.

    With no username/password, the saved ones are used, which is what makes an
    expired session renew itself silently.
    """
    if username is None:
        username = cfg.get("username")
    if not username:
        raise SessionExpired("no saved username — run `eversource.py login`.")
    if password is None:
        password = keychain_get(username)
    if not password:
        raise SessionExpired(
            f"no saved password for {username} — run `eversource.py login`."
        )

    emit(f"Signing in as {username}…")
    session = new_session()
    body = _eversource_signin(session, username, password)
    emit("Eversource session established; getting an Okta token…")
    _tokens_from_session_token(
        session,
        cfg,
        _session_token(
            session, cfg, body.get("OktaUsername") or username, password, mfa_prompt
        ),
    )

    cfg["username"] = username
    cfg["cookies"] = eversource_cookies(session)
    # A new session invalidates anything cached under the old one.
    for stale in ("accounts", "jwt", "opower_meta", "cookie"):
        cfg.pop(stale, None)
    save_config(cfg)
    if save_password:
        keychain_set(username, password)
    emit("Signed in.")
    return session


def access_token(cfg: Config, session: requests.Session) -> str:
    """Return an unexpired Okta access token, renewing from the refresh token.

    Raises SessionExpired if it can't be renewed silently; signing in again is
    the caller's job, because that replaces the session this one is bound to.
    """
    tokens: OktaTokens = cfg.get("okta", {})
    if tokens.get("access_token") and tokens.get("exp", 0) - EXPIRY_SKEW > time.time():
        return tokens["access_token"]

    if tokens.get("refresh_token"):
        response = session.post(
            f"{OKTA_ISSUER}/v1/token",
            data={
                "grant_type": "refresh_token",
                "client_id": OKTA_CLIENT_ID,
                "refresh_token": tokens["refresh_token"],
                "scope": OKTA_SCOPES,
            },
            headers={"Accept": "application/json"},
            timeout=60,
        )
        if response.ok:
            renewed = _store_tokens(cfg, response.json())
            save_config(cfg)
            return renewed["access_token"]

    raise SessionExpired("the Okta token could not be renewed.")
