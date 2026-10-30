"""FastAPI app behind the dashboard.

The page itself is a static asset (static/); this module only serves data and
runs the long operations (update, login) as background jobs the page polls.
Jobs run in plain threads because the Eversource client drives Playwright's
sync API, which must stay off the event loop.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import progress
from ..client import login
from ..config import CliError, Json, NoExports, SessionExpired, load_config
from ..data import cached_payload
from ..fetch import run_export, run_update

# With no exports at all, the first update bootstraps this much history.
FIRST_EXPORT_DAYS = 365

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Eversource dashboard")


# -------------------------------------------------------------------- jobs --


@dataclass
class Job:
    """One background operation (update or login) and its visible state."""

    kind: str
    running: bool = True
    log: list[str] = field(default_factory=list)
    error: str | None = None
    needs_login: bool = False

    def state(self) -> Json:
        return {
            "kind": self.kind,
            "running": self.running,
            "log": self.log,
            "error": self.error,
            "needs_login": self.needs_login,
            "ok": not self.running and self.error is None,
        }


_job_lock = threading.Lock()
_job: Job | None = None


def _run_job(job: Job, target) -> None:
    token = progress.set_sink(job.log.append)
    try:
        target()
    except SessionExpired as error:
        job.needs_login = True
        job.error = str(error)
    except CliError as error:
        job.error = str(error)
    except Exception as error:  # surfaced in the UI instead of a dead spinner
        job.error = f"{type(error).__name__}: {error}"
    finally:
        progress.reset_sink(token)
        job.running = False


def _start_job(kind: str, target) -> JSONResponse:
    global _job
    with _job_lock:
        if _job is not None and _job.running:
            return JSONResponse(_job.state(), status_code=409)
        _job = Job(kind)
        threading.Thread(target=_run_job, args=(_job, target), daemon=True).start()
        return JSONResponse(_job.state())


def _do_update() -> None:
    cfg = load_config()
    try:
        run_update(cfg, None, None)
    except NoExports:
        today = date.today()
        progress.emit(f"no exports yet — fetching the last {FIRST_EXPORT_DAYS} days")
        run_export(cfg, None, today - timedelta(days=FIRST_EXPORT_DAYS), today, None)


def _do_login() -> None:
    login(load_config())


# --------------------------------------------------------------- endpoints --


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


@app.post("/api/update")
def api_update() -> JSONResponse:
    return _start_job("update", _do_update)


@app.post("/api/login")
def api_login() -> JSONResponse:
    return _start_job("login", _do_login)


@app.get("/api/job")
def api_job() -> Json:
    return _job.state() if _job is not None else {"kind": None, "running": False}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
