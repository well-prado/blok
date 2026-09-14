"""The `stats` prop of the Dashboard page — computed in Python.

Nothing about Inertia reaches this file. It is an ordinary Blok node: it takes
inputs, returns output, and the runner persists the result at
`ctx.state["page.stats"]` before the serializer ships it.

The page declares it as `defer(dashboardStats, { group: "dashboard" })`, so the
first visit announces it and the client fetches it in a follow-up request —
which is exactly what you want for a query that takes a second.
"""

from __future__ import annotations

from blok import Context, node
from pydantic import BaseModel


class DashboardStatsInput(BaseModel):
    since: str


class DashboardStatsOutput(BaseModel):
    revenue: float
    orders: int


@node("dashboard-stats", "Aggregate revenue and order count since a date")
def dashboard_stats(ctx: Context, input: DashboardStatsInput) -> DashboardStatsOutput:
    # A real implementation would query a warehouse here.
    ctx.logger.info("aggregating dashboard stats since %s", input.since)
    return DashboardStatsOutput(revenue=42000.0, orders=128)
