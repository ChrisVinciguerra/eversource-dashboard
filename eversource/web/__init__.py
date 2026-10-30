"""Local dashboard web app."""

from __future__ import annotations

import threading
import webbrowser


def serve(port: int = 8537, open_browser: bool = True) -> None:
    """Run the dashboard server (and open it in the browser)."""
    import uvicorn

    url = f"http://127.0.0.1:{port}/"
    if open_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    uvicorn.run("eversource.web.app:app", host="127.0.0.1", port=port, log_level="warning")
