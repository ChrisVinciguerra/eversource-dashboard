"""Authenticated access to the Eversource and Opower APIs.

Auth model (reverse-engineered from the usage-detail page):
  1. Sign in over plain HTTP — see auth.py — which yields the eversource.com
     session cookies and an Okta access token.
  2. Eversource's own APIs need both: the cookies plus the Okta token as an
     Authorization: Bearer header. One such call,
     /cg/customer/api/accountbilling/getOpowerWidgetData/{account}, yields a
     short-lived (1h) Opower JWT.
  3. That JWT is the Bearer token for Opower's GraphQL API (ever.opower.com),
     which serves the daily / hourly / 15-min interval reads.

Nothing here needs a browser. An expired session is renewed in place — from
the refresh token, or failing that the keychain password — so callers only see
SessionExpired when there is genuinely nothing left to try.
"""

from __future__ import annotations

import base64
import json
import time
from http import HTTPStatus
from typing import Any, Self

import requests

from .auth import (
    API_HEADERS,
    access_token,
    credentials,
    load_cookies,
    login,
    new_session,
)
from .config import (
    ES,
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


def _has_meters(accounts: Json) -> bool:
    """Eversource nulls every meter list (with a 200) while billing is down."""
    return all(
        item["serviceMeterDetails"] is not None
        for item in accounts["accountSwitcherItems"]
    )


# ------------------------------------------------------------------ client --

# Tries per Eversource call: the second follows a fresh sign-in.
ATTEMPTS = 2


class Client:
    """Client for both backends behind this tool, over plain HTTP."""

    def __init__(self, cfg: Config) -> None:
        """Wrap a config; the HTTP session opens on first use."""
        self.cfg = cfg
        self._session: requests.Session | None = None

    def __enter__(self) -> Self:
        """Return the client itself."""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """Close the HTTP session if one was opened."""
        if self._session is not None:
            self._session.close()
            self._session = None

    # -- Eversource APIs -----------------------------------------------------

    def session(self) -> requests.Session:
        """Return a session carrying the saved Eversource cookies."""
        if self._session is None:
            if not self.cfg.get("cookies") and not credentials(self.cfg):
                raise SessionExpired(f"no saved session. {RELOGIN_HINT}")
            self._session = load_cookies(new_session(), self.cfg)
        return self._session

    def _reauth(self) -> None:
        """Sign in again in place, keeping the same Client usable."""
        if not credentials(self.cfg):
            raise SessionExpired(f"Eversource session expired. {RELOGIN_HINT}")
        emit("Session expired — signing in again…")
        self._session = login(self.cfg)

    def es_get(self, path: str) -> Any:  # noqa: ANN401 -- whatever JSON the API sends
        """GET an Eversource JSON API, renewing the session if it has lapsed."""
        for attempt in range(1, ATTEMPTS + 1):
            session = self.session()
            try:
                bearer = access_token(self.cfg, session)
            except SessionExpired:
                if attempt == ATTEMPTS:
                    raise
                self._reauth()
                continue

            response = session.get(
                ES + path,
                headers={**API_HEADERS, "Authorization": f"Bearer {bearer}"},
                allow_redirects=False,
                timeout=60,
            )
            # A lapsed ASP.NET session shows up as a 401/403, or as the login
            # page served with a 200 in place of the JSON that was asked for.
            stale = response.status_code in (401, 403) or (
                "json" not in response.headers.get("content-type", "")
            )
            if stale and attempt == 1:
                self._reauth()
                continue
            if response.status_code != HTTPStatus.OK:
                raise SessionExpired(
                    f"Eversource API {path} returned {response.status_code}. "
                    f"{RELOGIN_HINT}"
                )
            try:
                return response.json()
            except json.JSONDecodeError:
                raise SessionExpired(
                    "Eversource returned HTML instead of JSON (session expired?). "
                    f"{RELOGIN_HINT}"
                ) from None
        raise SessionExpired(f"could not re-establish the session. {RELOGIN_HINT}")

    def accounts(self) -> Json:
        """Return the account/meter directory for this login (cached)."""
        cached = self.cfg.get("accounts")
        if cached and _has_meters(cached):
            return cached
        fresh = self.es_get(
            "/account/api/account?getServiceAccountsAndMeterDetails=true"
            "&isActiveOnly=false&isLegacyIncluded=true"
        )
        # Only a new sign-in drops the cache, so an outage reply must not enter it.
        if _has_meters(fresh):
            self.cfg["accounts"] = fresh
            save_config(self.cfg)
        return fresh

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
        cached = self.cfg.get("jwt", {}).get(str(billing_account))
        if cached and cached["exp"] - 60 > time.time():
            return cached["token"]
        path = f"/cg/customer/api/accountbilling/getOpowerWidgetData/{billing_account}"
        data = self.es_get(path)
        if not data or not data.get("jwtToken"):
            # A session missing the web cookies gets a 200 "null" here rather
            # than a 401; a fresh sign-in fixes it.
            self._reauth()
            data = self.es_get(path)
        if not data or not data.get("jwtToken"):
            raise SessionExpired(
                f"Eversource returned no Opower token for account "
                f"{billing_account}. {RELOGIN_HINT}"
            )
        token = data["jwtToken"]
        payload = json.loads(
            base64.urlsafe_b64decode(token.split(".")[1] + "==").decode()
        )
        self.cfg.setdefault("jwt", {})[str(billing_account)] = {
            "token": token,
            "exp": payload["exp"],
        }
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

    def metadata(self, billing_account: str) -> Json:
        """Return the Opower urn and service agreement/point uuids (cached).

        Shape: {"selectedAccount": urn, "meters": [{"saUuid", "spUuid",
        "serviceType", "utilityId"}]}, one meter per service point.
        """
        key = str(billing_account)
        cached = self.cfg.get("opower_meta", {}).get(key)
        if cached is not None:
            return cached
        data = self.gql(
            billing_account,
            "WDB_GetMetadata",
            METADATA_QUERY,
            {"forceLegacyData": False, "aliased": True},
        )
        account = data["billingAccountByAuthContext"]
        meta = {
            "selectedAccount": account["urn"],
            "meters": [
                {
                    "saUuid": agreement["node"]["uuid"],
                    "spUuid": point["node"]["uuid"],
                    "serviceType": agreement["node"]["serviceType"],
                    "utilityId": point["node"]["utilityId"],
                }
                for agreement in account["serviceAgreementsConnection"]["edges"]
                for point in agreement["node"]["servicePointsConnection"]["edges"]
            ],
        }
        self.cfg.setdefault("opower_meta", {})[key] = meta
        save_config(self.cfg)
        return meta
