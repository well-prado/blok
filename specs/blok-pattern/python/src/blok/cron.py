"""Runs every workflow that has a cron trigger, on its schedule, inside this process.

    jobs = await start_cron(blok)

One process, one clock: an app that runs as several copies starts this in one of them,
or every copy runs every job.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from .kernel import BlokError
from .project import App
from .schedule import next_run, parse_schedule
from .workflow import CronBinding


class Timers(Protocol):
    """The clock and the wait, so that a test can move time by hand."""

    def now(self) -> float:
        """The time in milliseconds."""
        ...

    def sleep(self, seconds: float) -> Awaitable[None]: ...


class _Real:
    def now(self) -> float:
        return time.time() * 1000

    def sleep(self, seconds: float) -> Awaitable[None]:
        return asyncio.sleep(seconds)


# A job further away than a day is looked at again then, so a clock that was set is noticed.
_LONGEST = 24 * 60 * 60


def iso(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


@dataclass(frozen=True)
class CronRun:
    #: The workflow.
    id: str
    #: The moment on the schedule this run is for.
    at: datetime
    ok: bool
    #: "skipped" when the run before it was still going.
    error: str | None = None


class Job:
    def __init__(self, id: str, schedule: str, timezone: str, upcoming: datetime) -> None:
        self.id = id
        self.schedule = schedule
        self.timezone = timezone
        self._next = upcoming

    def next(self) -> datetime:
        return self._next


class CronJobs:
    def __init__(self, jobs: list[Job], stop: Callable[[], Awaitable[None]]) -> None:
        self.jobs = jobs
        self._stop = stop

    async def stop(self) -> None:
        """Stops the schedules and waits for the runs that are going."""
        await self._stop()


async def start_cron(
    blok: App, *, timers: Timers | None = None, on_run: Callable[[CronRun], Any] | None = None
) -> CronJobs:
    """`on_run` is called after every run, and for every run that was skipped."""
    clock: Timers = timers or _Real()
    going: set[asyncio.Task[None]] = set()
    loops: list[asyncio.Task[None]] = []
    jobs: list[Job] = []

    def moment() -> datetime:
        return datetime.fromtimestamp(clock.now() / 1000, UTC)

    for binding in blok.bindings:
        if not isinstance(binding, CronBinding):
            continue
        id = binding.unit.id
        schedule = parse_schedule(binding.schedule)
        job = Job(id, binding.schedule, binding.timezone, next_run(schedule, moment(), binding.timezone))
        jobs.append(job)
        state = {"running": False}

        async def run(
            at: datetime, binding: CronBinding = binding, id: str = id, state: dict[str, bool] = state
        ) -> None:
            # A run that takes longer than its interval is not joined by a second one. The late one is skipped.
            if state["running"]:
                blok.log.error(f"{id} was not started at {iso(at)}: the run before it is still going.")
                if on_run:
                    on_run(CronRun(id=id, at=at, ok=False, error="skipped"))
                return
            state["running"] = True
            try:
                await blok.call(binding.unit, {"body": binding.body})
                if on_run:
                    on_run(CronRun(id=id, at=at, ok=True))
            except Exception as err:
                # Nobody is waiting for an answer, so the log is the only place a failed run shows.
                error = err if isinstance(err, BlokError) else BlokError("unexpected", str(err), id)
                blok.log.error(
                    f'{id}, started by its schedule, failed with "{error.code}" at {error.node}: {error.message}'
                )
                if on_run:
                    on_run(CronRun(id=id, at=at, ok=False, error=error.code))
            finally:
                state["running"] = False

        async def watch(
            job: Job = job, schedule: Any = schedule, binding: CronBinding = binding, run: Any = run
        ) -> None:
            while True:
                wait = max(0.0, job.next().timestamp() - clock.now() / 1000)
                await clock.sleep(min(wait, _LONGEST))
                if clock.now() >= job.next().timestamp() * 1000:
                    at = job.next()
                    job._next = next_run(schedule, moment(), binding.timezone)
                    one = asyncio.ensure_future(run(at))
                    going.add(one)
                    one.add_done_callback(going.discard)

        loops.append(asyncio.ensure_future(watch()))

    async def stop() -> None:
        for loop in loops:
            loop.cancel()
        await asyncio.gather(*loops, return_exceptions=True)
        await asyncio.gather(*going, return_exceptions=True)

    return CronJobs(jobs, stop)
