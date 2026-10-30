#!/usr/bin/env python3
"""Entry point shim — the real code lives in the eversource/ package.

Run via uv so the project environment is used:
    uv run eversource.py <command>
"""

from eversource.cli import main

if __name__ == "__main__":
    main()
