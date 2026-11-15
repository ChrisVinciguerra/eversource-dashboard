"""FastAPI app behind the dashboard.

The page itself is a static asset (static/); this module only serves data and
runs the long operations (update, sign-in) as background jobs the page polls.
Jobs run in plain threads because the Eversource client is synchronous and
blocking, and must stay off the event loop.

Signing in needs two round trips to the user when MFA is involved, so the job
blocks on an Event while the page POSTs the verification code to /api/mfa.
"""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles

from .. import progress
from ..auth import credentials, login
from ..config import (
    EXPORT_GLOB,
    EXPORT_ROOT,
    CliError,
    Json,
    NoExports,
    SessionExpired,
    load_config,
)
from ..data import cached_payload
from ..devices import refresh_device_sources
from ..fetch import run_export, run_update

# How long the sign-in job waits for the MFA code before giving up.
MFA_WAIT_SECONDS = 300

# With no exports at all, the first update bootstraps this much history.
FIRST_EXPORT_DAYS = 365

# Reads post in blocks hours apart, so after a successful pull (even an empty
# one) the page waits this long before pulling again on its own.
RECHECK_SECONDS = 30 * 60

# After a failed job the automatic pull retries sooner, doubling from this up
# to RECHECK_SECONDS so a persistent failure (bad password, Eversource down)
# is not hammered.
RETRY_SECONDS = 2 * 60

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Eversource dashboard")


# -------------------------------------------------------------------- jobs --


@dataclass
class Job:
    """One background operation (update or sign-in) and its visible state."""

    kind: str
    running: bool = True
    log: list[str] = field(default_factory=list)
    error: str | None = None
    needs_login: bool = False
    # Set while the sign-in job is blocked waiting for a verification code.
    mfa_prompt: str | None = None
    _mfa_code: str | None = None
    _mfa_ready: threading.Event = field(default_factory=threading.Event)

    def state(self) -> Json:
        if self.running:
            status = "running"
        elif self.error is not None:
            status = "error"
        else:
            status = "ok"
        return {
            "kind": self.kind,
            "status": status,
            "running": self.running,
            "log": self.log,
            "error": self.error,
            "needs_login": self.needs_login,
            "needs_mfa": self.mfa_prompt is not None and self._mfa_code is None,
            "mfa_prompt": self.mfa_prompt,
        }

    def ask_for_mfa(self, description: str) -> str:
        """Block until the page posts a code; raises if the user never does."""
        self.mfa_prompt = description
        if not self._mfa_ready.wait(MFA_WAIT_SECONDS):
            raise CliError("timed out waiting for the verification code.")
        assert self._mfa_code is not None
        return self._mfa_code

    def supply_mfa(self, code: str) -> None:
        self._mfa_code = code
        self._mfa_ready.set()


_job_lock = threading.Lock()
_job: Job | None = None


def _newest_export_time() -> float | None:
    times = [p.stat().st_mtime for p in EXPORT_ROOT.glob(EXPORT_GLOB) if p.is_dir()]
    return max(times, default=None)


# When to pull next is decided here, not in the browser, so every tab and
# device agrees and a reload can't be blocked by a stamp left in one browser.
# Seeded from the newest export so a restart doesn't count as "never checked".
_last_ok: float | None = _newest_export_time()
_last_fail: float | None = None
_fails = 0  # consecutive failed jobs


def _record_result(job: Job) -> None:
    global _last_ok, _last_fail, _fails
    if job.error is not None:
        _fails += 1
        _last_fail = time.time()
        # Job errors otherwise live only in memory; keep a trace in the journal.
        print(f"{job.kind} failed: {job.error}", file=sys.stderr, flush=True)
        return
    _fails = 0
    if job.kind == "update":
        _last_ok = time.time()


def _freshness() -> Json:
    """Whether the last attempt failed, and whether an automatic pull is due."""
    now = time.time()
    if _job is not None and _job.running:
        due = False
    elif _fails and _last_fail is not None:
        wait = min(RECHECK_SECONDS, RETRY_SECONDS * 2 ** (_fails - 1))
        due = now - _last_fail >= wait
    else:
        due = _last_ok is None or now - _last_ok >= RECHECK_SECONDS
    return {"failing": _fails > 0, "check_due": due}


def _run_job(job: Job, target) -> None:
    token = progress.set_sink(job.log.append)
    try:
        target(job)
    except SessionExpired as error:
        job.needs_login = True
        job.error = str(error)
    except CliError as error:
        job.error = str(error)
    except Exception as error:  # surfaced in the UI instead of a dead spinner
        job.error = f"{type(error).__name__}: {error}"
    finally:
        progress.reset_sink(token)
        job.mfa_prompt = None
        _record_result(job)
        job.running = False


def _start_job(kind: str, target) -> JSONResponse:
    global _job
    with _job_lock:
        if _job is not None and _job.running:
            return JSONResponse(_job.state(), status_code=409)
        _job = Job(kind)
        threading.Thread(target=_run_job, args=(_job, target), daemon=True).start()
        return JSONResponse(_job.state())


def _do_update(job: Job) -> None:
    cfg = load_config()
    try:
        run_update(cfg, None, None)
    except NoExports:
        today = date.today()
        progress.emit(f"no exports yet — fetching the last {FIRST_EXPORT_DAYS} days")
        run_export(cfg, None, today - timedelta(days=FIRST_EXPORT_DAYS), today, None)


# --------------------------------------------------------------- endpoints --


class Credentials(BaseModel):
    """Sign-in form payload. Both are optional: saved ones are used if absent."""

    username: str | None = None
    password: str | None = None


class MfaCode(BaseModel):
    code: str


@app.get("/api/data")
def api_data() -> Json:
    try:
        return cached_payload()
    except NoExports as error:
        return {
            "intervals": {},
            "monthly": None,
            "bills": None,
            "last_read": None,
            "note": str(error),
        }


@app.post("/api/refresh-devices")
def api_refresh_devices() -> Json:
    """Re-pull device specs that name a remote source (best effort, bounded
    by short timeouts). Runs in FastAPI's threadpool, off the event loop."""
    return {"changed": refresh_device_sources()}


@app.post("/api/update")
def api_update() -> JSONResponse:
    return _start_job("update", _do_update)


@app.get("/api/session")
def api_session() -> Json:
    """Whether the dashboard can sign in without asking for anything."""
    cfg = load_config()
    return {
        "username": cfg.get("username"),
        "ready": credentials(cfg) is not None,
    }


@app.post("/api/login")
def api_login(body: Credentials) -> JSONResponse:
    def target(job: Job) -> None:
        login(load_config(), body.username, body.password, mfa_prompt=job.ask_for_mfa)

    return _start_job("login", target)


@app.post("/api/mfa")
def api_mfa(body: MfaCode) -> JSONResponse:
    if _job is None or not _job.running or _job.mfa_prompt is None:
        return JSONResponse({"error": "no sign-in is waiting for a code"}, 409)
    _job.supply_mfa(body.code)
    return JSONResponse(_job.state())


@app.get("/api/job")
def api_job() -> Json:
    state = (
        _job.state()
        if _job is not None
        else {"kind": None, "status": "idle", "running": False}
    )
    return {**state, **_freshness()}


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers revalidate static files (ETag 304s), not heuristically
    cache them — a stale app.js against a fresh index.html breaks the page."""
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
