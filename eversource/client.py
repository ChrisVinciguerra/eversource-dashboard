"""Authenticated access to the Eversource and Opower APIs.

Auth model (reverse-engineered from the usage-detail page):
  1. Sign in through Eversource's Okta login in a real browser window (the
     login() flow). The session lives in a persistent Chromium profile.
  2. Eversource's own APIs need the session cookies plus an Okta access token
     (Authorization: Bearer) that the site's SPA keeps in localStorage, so the
     Client calls them with in-page fetch()es from a headless Chromium reusing
     that profile. One such call,
     /cg/customer/api/accountbilling/getOpowerWidgetData/{account}, yields a
     short-lived (1h) Opower JWT.
  3. That JWT is the Bearer token for Opower's GraphQL API (ever.opower.com),
     which serves the daily / hourly / 15-min interval reads.
"""

from __future__ import annotations

import base64
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any, Self, TypedDict

import requests

from .config import (
    ACCOUNT_URL,
    BROWSER_PROFILE,
    ES,
    LOGIN_URL,
    OPOWER_GQL,
    RELOGIN_HINT,
    UA,
    CliError,
    Config,
    Json,
    SessionExpired,
    save_config,
)
from .progress import emit

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page, Playwright


class JwtCache(TypedDict):
    """Cached Opower JWT and its expiry (epoch seconds)."""

    token: str
    exp: int


@dataclass(frozen=True, slots=True)
class Meter:
    """One service-point meter on a billing account."""

    sa_uuid: str
    sp_uuid: str
    service_type: str
    utility_id: str

    @classmethod
    def from_json(cls, raw: Json) -> Self:
        return cls(
            sa_uuid=raw["saUuid"],
            sp_uuid=raw["spUuid"],
            service_type=raw["serviceType"],
            utility_id=raw["utilityId"],
        )

    def to_json(self) -> Json:
        return {
            "saUuid": self.sa_uuid,
            "spUuid": self.sp_uuid,
            "serviceType": self.service_type,
            "utilityId": self.utility_id,
        }


@dataclass(frozen=True, slots=True)
class AccountMetadata:
    """Opower account urn plus the meters it bills for."""

    selected_account: str
    meters: list[Meter]

    @classmethod
    def from_json(cls, raw: Json) -> Self:
        return cls(
            selected_account=raw["selectedAccount"],
            meters=[Meter.from_json(meter) for meter in raw["meters"]],
        )

    def to_json(self) -> Json:
        return {
            "selectedAccount": self.selected_account,
            "meters": [meter.to_json() for meter in self.meters],
        }


# ---------------------------------------------------------------- GraphQL ---

METADATA_QUERY = """
query WDB_GetMetadata($selectedAccount: ID, $forceLegacyData: Boolean, $aliased: Boolean) {
  billingAccountByAuthContext(selectedAccount: $selectedAccount, forceLegacyData: $forceLegacyData) {
    urn
    uuid
    utilityId
    serviceAgreementsConnection(onlyActive: true, aliased: $aliased) {
      edges {
        node {
          uuid
          serviceType
          utilityId
          servicePointsConnection {
            edges { node { uuid serviceType utilityId } }
          }
        }
      }
    }
  }
}
"""

READS_QUERY = """
query WDB_GetUsageReadsForDayAndHourWithIntervalReads($selectedAccount: ID, $timeInterval: TimeInterval, $resolution: ReadResolution, $forceLegacyData: Boolean, $aliased: Boolean, $saUuid: String, $spUuid: String) {
  billingAccountByAuthContext(selectedAccount: $selectedAccount, forceLegacyData: $forceLegacyData) {
    serviceAgreementsConnection(onlyActive: true, aliased: $aliased, matching: $saUuid) {
      edges {
        node {
          uuid
          serviceType
          servicePointsConnection(matching: $spUuid) {
            edges {
              node {
                uuid
                utilityId
                readStreams(timeInterval: $timeInterval, readResolution: $resolution) {
                  timeInterval
                  netUsage {
                    serviceQuantityIdentifier
                    unit
                    reads {
                      readType
                      timeInterval
                      measuredAmount { unit value }
                      isPeakPeriod
                    }
                  }
                  energyDelivered {
                    serviceQuantityIdentifier
                    unit
                    reads { readType timeInterval measuredAmount { unit value } }
                  }
                  energyReceived {
                    serviceQuantityIdentifier
                    unit
                    reads { readType timeInterval measuredAmount { unit value } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"""

BILLS_QUERY = """
query WDB_GetCostUsageReadsForBills($selectedAccount: ID, $last: Int, $timeInterval: TimeInterval, $forceLegacyData: Boolean, $aliased: Boolean) {
  billingAccountByAuthContext(selectedAccount: $selectedAccount, forceLegacyData: $forceLegacyData) {
    urn
    bills(last: $last, during: $timeInterval, orderBy: ASCENDING, preserveDuplicateSegments: true) {
      urn
      timeInterval
      segments {
        usageInterval
        serviceAgreement(aliased: $aliased) { uuid serviceType }
        estimated
        serviceQuantities {
          unit
          serviceQuantityIdentifier
          serviceQuantity { value }
        }
        usageCharges { value }
        currentAmount { value }
      }
    }
  }
}
"""


# ------------------------------------------------------------------ client --


class Client:
    """Client for both backends behind this tool.

    Eversource is driven through a headless browser because its APIs reject
    non-browser clients even with valid cookies; Opower is plain requests.
    """

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._playwright: Playwright | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    # -- Eversource (in-browser) APIs ----------------------------------------

    def _browser_page(self) -> Page:
        """Return a headless page with a live Eversource session."""
        if self._page is not None:
            return self._page

        if not self.cfg.get("cookies"):
            raise SessionExpired(f"no saved session. {RELOGIN_HINT}")
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        context = self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(BROWSER_PROFILE),
            headless=True,
            user_agent=UA,
        )
        self._context = context
        # Auth cookies are session cookies and don't survive a browser
        # restart on their own — re-inject the ones captured at login.
        context.add_cookies(self.cfg["cookies"])
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(ACCOUNT_URL, wait_until="domcontentloaded")
        if "/security/account/login" in page.url:
            raise SessionExpired(f"Eversource session expired. {RELOGIN_HINT}")
        # Let the SPA settle — it refreshes the Okta token we need. A chatty
        # page may never go idle; the token is usually there regardless.
        with suppress(PlaywrightTimeoutError):
            page.wait_for_load_state("networkidle", timeout=15000)
        self._page = page
        return page

    def _bearer(self) -> str:
        """Return the Okta access token the SPA stores in localStorage.

        Eversource's APIs require it as a Bearer header on top of the cookies.
        """
        token = self._browser_page().evaluate(
            "() => JSON.parse(localStorage.getItem('okta-token-storage') || '{}')"
            "?.accessToken?.accessToken"
        )
        if not token:
            raise SessionExpired(f"no Okta token in the browser session. {RELOGIN_HINT}")
        return token

    def close(self) -> None:
        if self._page is None:
            return
        assert self._context is not None and self._playwright is not None
        self._context.close()
        self._playwright.stop()
        self._page = None

    def es_get(self, path: str) -> Any:
        """GET an Eversource JSON API from inside the authenticated page."""
        status, body = self._browser_page().evaluate(
            """async ([path, bearer]) => {
                const r = await fetch(path, {
                    headers: {
                        Accept: 'application/json',
                        Authorization: 'Bearer ' + bearer,
                    },
                    credentials: 'include',
                });
                return [r.status, await r.text()];
            }""",
            [path, self._bearer()],
        )
        if status != 200:
            raise SessionExpired(
                f"Eversource API {path} returned {status}. "
                f"If this persists, re-login. {RELOGIN_HINT}"
            )
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise SessionExpired(
                "Eversource returned HTML instead of JSON (session expired?). "
                f"{RELOGIN_HINT}"
            ) from None

    def accounts(self) -> Json:
        """Return the account/meter directory for this login (cached)."""
        if "accounts" not in self.cfg:
            self.cfg["accounts"] = self.es_get(
                "/account/api/account?getServiceAccountsAndMeterDetails=true"
                "&isActiveOnly=false&isLegacyIncluded=true"
            )
            save_config(self.cfg)
        return self.cfg["accounts"]

    def pick_account(self, number: str | None) -> Json:
        """Return the requested billing account, or the first one."""
        items = self.accounts()["accountSwitcherItems"]
        if not items:
            raise CliError("no billing accounts found on this login")
        if number is None:
            return items[0]
        for item in items:
            if str(item["billingAccountIdentifier"]) == str(number):
                return item
        raise CliError(
            f"account {number} not found; run `eversource.py accounts` to list"
        )

    # -- Opower JWT ----------------------------------------------------------

    def jwt(self, billing_account: str) -> str:
        """Return an unexpired Opower bearer token, minting one if needed."""
        cached: JwtCache | None = self.cfg.get("jwt", {}).get(str(billing_account))
        if cached and cached["exp"] - 60 > time.time():
            return cached["token"]
        data = self.es_get(
            f"/cg/customer/api/accountbilling/getOpowerWidgetData/{billing_account}"
        )
        token = data["jwtToken"]
        payload = json.loads(
            base64.urlsafe_b64decode(token.split(".")[1] + "==").decode()
        )
        self.cfg.setdefault("jwt", {})[str(billing_account)] = JwtCache(
            token=token, exp=payload["exp"]
        )
        save_config(self.cfg)
        return token

    # -- Opower GraphQL -------------------------------------------------------

    def gql(
        self,
        billing_account: str,
        operation: str,
        query: str,
        variables: Json,
    ) -> Json:
        """Run one Opower GraphQL operation and return its data block."""
        response = requests.post(
            OPOWER_GQL,
            json={"operationName": operation, "query": query, "variables": variables},
            headers={
                "User-Agent": UA,
                "Authorization": f"Bearer {self.jwt(billing_account)}",
                "opower-selected-entities": json.dumps(
                    [f"urn:external:opower:entity:id:{billing_account}"]
                ),
                "Origin": ES,
                "Referer": ES + "/",
            },
            timeout=60,
        )
        response.raise_for_status()
        body = response.json()
        if body.get("errors"):
            raise CliError(
                f"GraphQL error in {operation}: {json.dumps(body['errors'])[:500]}"
            )
        return body["data"]

    def metadata(self, billing_account: str) -> AccountMetadata:
        """Return the Opower urn and service agreement/point uuids (cached)."""
        key = str(billing_account)
        cached = self.cfg.get("opower_meta", {}).get(key)
        if cached is not None:
            return AccountMetadata.from_json(cached)
        data = self.gql(
            billing_account,
            "WDB_GetMetadata",
            METADATA_QUERY,
            {"forceLegacyData": False, "aliased": True},
        )
        account = data["billingAccountByAuthContext"]
        meta = AccountMetadata(
            selected_account=account["urn"],
            meters=[
                Meter(
                    sa_uuid=agreement["node"]["uuid"],
                    sp_uuid=point["node"]["uuid"],
                    service_type=agreement["node"]["serviceType"],
                    utility_id=point["node"]["utilityId"],
                )
                for agreement in account["serviceAgreementsConnection"]["edges"]
                for point in agreement["node"]["servicePointsConnection"]["edges"]
            ],
        )
        self.cfg.setdefault("opower_meta", {})[key] = meta.to_json()
        save_config(self.cfg)
        return meta


# ------------------------------------------------------------------- login --


def login(cfg: Config, timeout: float = 300) -> Json:
    """Open a browser window, let the user sign in, and capture the session.

    Returns the account directory for the fresh session. Used by both the
    `login` CLI command and the dashboard's log-in button.
    """
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise CliError(
            "playwright is not installed. Install it with:\n"
            "    uv add playwright && uv run playwright install chromium"
        ) from None

    emit(
        "Opening a browser to the Eversource sign-in page.\n"
        "Log in normally (username, password, and MFA if prompted).\n"
        "The window closes by itself once your account page has loaded its data."
    )

    BROWSER_PROFILE.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(BROWSER_PROFILE),
            headless=False,
            user_agent=UA,
            args=["--no-first-run"],
        )

        # Don't trust the URL to mean "signed in" — wait until the site itself
        # gets a 200 from an authenticated API, which proves the session is live.
        authenticated = False

        def on_response(response: Any) -> None:
            nonlocal authenticated
            if response.status == 200 and (
                "/account/api/account" in response.url
                or "/cg/customer/api/" in response.url
            ):
                authenticated = True

        context.on("response", on_response)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(LOGIN_URL)

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not authenticated:
            page.wait_for_timeout(500)

        if not authenticated:
            context.close()
            raise CliError(
                "timed out waiting for an authenticated API call. If you were "
                "signed in, try visiting your account or usage page before the "
                "timeout, or increase --timeout."
            )

        # Let in-flight requests finish setting their cookies; polling widgets
        # can keep the page busy past the timeout, by which point they are set.
        with suppress(PlaywrightTimeoutError):
            page.wait_for_load_state("networkidle", timeout=10000)
        cookies = context.cookies()
        context.close()

    # Session cookies don't persist across browser restarts, so keep the full
    # cookie objects and re-inject them on each headless run. Fresh session:
    # drop anything cached under the old one.
    cfg["cookies"] = [
        cookie
        for cookie in cookies
        if cookie["domain"].lstrip(".").endswith("eversource.com")
    ]
    cfg.pop("accounts", None)
    cfg.pop("jwt", None)
    cfg.pop("opower_meta", None)
    cfg.pop("cookie", None)  # legacy header-string format
    save_config(cfg)

    with Client(cfg) as client:
        return client.accounts()
