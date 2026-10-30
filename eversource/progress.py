"""Progress reporting that works for both the CLI and the web server.

Library code calls emit(); by default messages go to stderr (the CLI
behaviour). The web server redirects them into a per-job log by setting a sink
for the duration of a background job.
"""

from __future__ import annotations

import sys
from contextvars import ContextVar, Token
from typing import Callable

Sink = Callable[[str], None]

_sink: ContextVar[Sink | None] = ContextVar("progress_sink", default=None)


def emit(message: str) -> None:
    """Report a progress message to the active sink (stderr by default)."""
    sink = _sink.get()
    if sink is None:
        print(message, file=sys.stderr)
    else:
        sink(message)


def set_sink(sink: Sink) -> Token[Sink | None]:
    return _sink.set(sink)


def reset_sink(token: Token[Sink | None]) -> None:
    _sink.reset(token)
