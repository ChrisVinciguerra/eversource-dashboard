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
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self, TypedDict

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
    """Client for both backends behind this tool, over plain HTTP."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._session: requests.Session | None = None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
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

    def es_get(self, path: str) -> Any:
        """GET an Eversource JSON API, renewing the session if it has lapsed."""
        for attempt in (1, 2):
            session = self.session()
            try:
                bearer = access_token(self.cfg, session)
            except SessionExpired:
                if attempt == 2:
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
            if response.status_code != 200:
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
