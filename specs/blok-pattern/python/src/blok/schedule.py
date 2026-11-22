"""Cron schedules: reading one, and working out when it next happens. Nothing here waits or runs anything.

Five fields, as in crontab: minute, hour, day of month, month, day of week.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, tzinfo
from zoneinfo import ZoneInfo


class UnreadableSchedule(ValueError):
    """The text is not a schedule. The message says which part is wrong."""


class NeverHappens(ValueError):
    """The schedule reads fine and names a moment that does not exist, such as 31 February."""


@dataclass(frozen=True)
class Schedule:
    minute: frozenset[int]
    hour: frozenset[int]
    day: frozenset[int]
    month: frozenset[int]
    #: 0 is Sunday.
    weekday: frozenset[int]
    #: Whether the day of month and the day of week were left open with "*".
    any_day: bool
    any_weekday: bool


_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
_SHORT = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}
_DIGITS = re.compile(r"[0-9]+")
_STEP = re.compile(r"[1-9][0-9]*")


def _field(text: str, what: str, low: int, high: int, names: list[str] | None = None) -> set[int]:
    def number(raw: str) -> int:
        if names and raw.lower() in names:
            value = names.index(raw.lower()) + (1 if names is _MONTHS else 0)
        elif _DIGITS.fullmatch(raw):
            value = int(raw)
        else:
            raise UnreadableSchedule(f'"{raw}" is not a {what}')
        if value < low or value > high:
            raise UnreadableSchedule(f"{what} {raw} is outside {low}-{high}")
        return value

    out: set[int] = set()
    for part in text.split(","):
        span, *rest = part.split("/")
        if span == "" or len(rest) > 1:
            raise UnreadableSchedule(f'"{part}" is not a {what}')
        every = rest[0] if rest else None
        if every is not None and not _STEP.fullmatch(every):
            raise UnreadableSchedule(f'"{part}" has a step that is not a number above 0')
        start_text, *more = [str(low), str(high)] if span == "*" else span.split("-")
        if len(more) > 1 or (more and more[0] == ""):
            raise UnreadableSchedule(f'"{part}" is not a {what}')
        start = number(start_text)
        # "5/15" means from 5 to the end, every 15.
        end = number(more[0]) if more else (start if every is None else high)
        if end < start:
            raise UnreadableSchedule(f'"{part}" runs backwards')
        out.update(range(start, end + 1, int(every or 1)))
    return out


def parse_schedule(text: str) -> Schedule:
    """Reads "0 2 * * *". Raises `UnreadableSchedule`, which says which part is wrong."""
    fields = _SHORT.get(text.strip().lower(), text).split()
    if len(fields) != 5:
        raise UnreadableSchedule(
            f"it has {len(fields)} {'part' if len(fields) == 1 else 'parts'}, and a schedule has five: "
            "minute, hour, day of month, month, day of week"
        )
    weekday = _field(fields[4], "day of the week", 0, 7, _WEEKDAYS)
    # Both 0 and 7 are Sunday.
    if 7 in weekday:
        weekday = (weekday - {7}) | {0}
    return Schedule(
        minute=frozenset(_field(fields[0], "minute", 0, 59)),
        hour=frozenset(_field(fields[1], "hour", 0, 23)),
        day=frozenset(_field(fields[2], "day of the month", 1, 31)),
        month=frozenset(_field(fields[3], "month", 1, 12, _MONTHS)),
        weekday=frozenset(weekday),
        any_day=fields[2].startswith("*"),
        any_weekday=fields[4].startswith("*"),
    )


_zones: dict[str, tzinfo] = {"UTC": UTC}


def time_zone(name: str) -> tzinfo:
    """Raises `ValueError` when the name is not a time zone."""
    zone = _zones.get(name)
    if zone is None:
        try:
            zone = ZoneInfo(name)
        except Exception as err:
            raise ValueError(f'"{name}" is not a time zone') from err
        _zones[name] = zone
    return zone


def _wall(at: int, zone: tzinfo) -> tuple[int, int, int, int, int]:
    """What a clock on the wall in that time zone shows at this moment: month, day, weekday, hour, minute."""
    shown = datetime.fromtimestamp(at, zone)
    return shown.month, shown.day, (shown.weekday() + 1) % 7, shown.hour, shown.minute


_MINUTE = 60


def next_run(schedule: Schedule, after: datetime, zone: str = "UTC") -> datetime:
    """The first moment after `after` that the schedule matches, to the minute.

    In a time zone that moves its clocks: a time the clocks skip does not run that day, and a time they
    repeat runs twice. UTC, the default, has neither.
    """
    tz = time_zone(zone)
    at = int(after.timestamp() // _MINUTE) * _MINUTE + _MINUTE
    # Five years covers 29 February. A schedule with no match by then, such as 31 February, has none.
    end = at + 5 * 366 * 24 * 60 * _MINUTE
    while at < end:
        month, day, weekday, hour, minute = _wall(at, tz)
        on_day = day in schedule.day
        on_weekday = weekday in schedule.weekday
        # As in crontab: when both the day of the month and the day of the week are given, either one is enough.
        either = on_day and on_weekday if schedule.any_day or schedule.any_weekday else on_day or on_weekday
        if not (month in schedule.month and either):
            # Jump to the next midnight on the wall. When the clocks moved on the way, land on the first minute of that day.
            at += (24 * 60 - (hour * 60 + minute)) * _MINUTE
            landed = _wall(at, tz)
            if landed[:2] != (month, day) and landed[3] * 60 + landed[4] > 0:
                while _wall(at - _MINUTE, tz)[:2] == landed[:2]:
                    at -= _MINUTE
        elif hour not in schedule.hour:
            at += (60 - minute) * _MINUTE
        elif minute not in schedule.minute:
            at += _MINUTE
        else:
            return datetime.fromtimestamp(at, UTC)
    raise NeverHappens("it never happens")
