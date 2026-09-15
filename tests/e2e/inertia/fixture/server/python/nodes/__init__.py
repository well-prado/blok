"""Project node registration for the Python3 runtime.

Registration is manual: import each node module for its `@node` decorator to
run, then hand the decorated registry over. `use:` on the TypeScript side must
match the STRING in `@node("dashboard-stats", …)`, not the function name.
"""

from __future__ import annotations

from blok import register_decorated

from . import dashboard_stats  # noqa: F401


def register_project_nodes(registry):
    return register_decorated(registry)
