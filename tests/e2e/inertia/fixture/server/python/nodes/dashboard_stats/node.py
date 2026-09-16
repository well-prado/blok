"""The Dashboard's deferred `stats` prop — computed in Python, for real.

Nothing about Inertia reaches this file. It is an ordinary Blok node running in
the `runtime.python3` sidecar.

It also keeps a CALL COUNTER in the file named by `BLOK_E2E_PY_COUNTER`. That
is what lets scenario 8 assert SERVER-SIDE that the deferred prop resolved
exactly once, and only in the client's follow-up request — the browser cannot
see whether a node ran, and a DOM assertion alone would pass against a prop
that shipped on the first visit.
"""

from __future__ import annotations

import os
from pathlib import Path

from blok import Context, node
from pydantic import BaseModel


class DashboardStatsInput(BaseModel):
    since: str


class DashboardStatsOutput(BaseModel):
    revenue: float
    orders: int
    calls: int


def _count() -> int:
    path = os.environ.get("BLOK_E2E_PY_COUNTER")
    if not path:
        return 0
    file = Path(path)
    try:
        current = int(file.read_text().strip() or "0")
    except (OSError, ValueError):
        current = 0
    current += 1
    file.write_text(str(current))
    return current


@node("dashboard-stats", "Aggregate revenue and order count since a date")
def dashboard_stats(ctx: Context, input: DashboardStatsInput) -> DashboardStatsOutput:
    return DashboardStatsOutput(revenue=42000.0, orders=128, calls=_count())
