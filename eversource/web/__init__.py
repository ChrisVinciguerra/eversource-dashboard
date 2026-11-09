"""Local dashboard web app."""

from __future__ import annotations

import threading
import webbrowser


def serve(port: int = 8537, open_browser: bool = True, host: str = "127.0.0.1") -> None:
    """Run the dashboard server (and open it in the browser)."""
    import uvicorn

    url = f"http://127.0.0.1:{port}/"
    if open_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    uvicorn.run("eversource.web.app:app", host=host, port=port, log_level="warning")


def serve_main() -> None:
    """`uv run serve` entry point — headless server, HOST/PORT from env.

    Same contract as the other homelab apps (seedhost-web, backup-timeline):
    install with `uv sync`, run with `uv run serve`.
    """
    import os

    serve(port=int(os.environ.get("PORT", "8537")),
          open_browser=False,
          host=os.environ.get("HOST", "0.0.0.0"))
