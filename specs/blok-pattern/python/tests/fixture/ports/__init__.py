"""The ports of the fixture: one journal the nodes write to."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Ports:
    journal: list[str] = field(default_factory=list)


def memory_ports() -> Ports:
    return Ports()


ports = memory_ports()
