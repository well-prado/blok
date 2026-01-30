from __future__ import annotations
import json
import threading
from datetime import datetime, timezone
from enum import IntEnum
from typing import Any, Dict, List, Optional


class LogLevel(IntEnum):
    DEBUG = 0
    INFO = 1
    WARN = 2
    ERROR = 3


_LEVEL_NAMES = {
    LogLevel.DEBUG: "DEBUG",
    LogLevel.INFO: "INFO",
    LogLevel.WARN: "WARN",
    LogLevel.ERROR: "ERROR",
}


def _parse_log_level(level: str) -> LogLevel:
    """Parse a log level string to LogLevel enum."""
    mapping = {"DEBUG": LogLevel.DEBUG, "INFO": LogLevel.INFO, "WARN": LogLevel.WARN, "ERROR": LogLevel.ERROR}
    return mapping.get(level.upper(), LogLevel.INFO)


class Logger:
    """Structured logger with a capture buffer.

    Log entries are captured and can be returned in ExecutionResult.logs.
    """

    def __init__(self, min_level: LogLevel = LogLevel.INFO):
        self._entries: List[str] = []
        self._min_level = min_level
        self._lock = threading.Lock()

    @classmethod
    def from_level_str(cls, level: str) -> Logger:
        return cls(min_level=_parse_log_level(level))

    def _log(self, level: LogLevel, message: str, fields: Optional[Dict[str, Any]] = None) -> None:
        if level < self._min_level:
            return

        ts = datetime.now(timezone.utc).isoformat()
        level_name = _LEVEL_NAMES[level]

        if fields:
            fields_str = " " + json.dumps(fields, default=str)
        else:
            fields_str = ""

        entry = f"[{level_name}] {ts} {message}{fields_str}"

        with self._lock:
            self._entries.append(entry)

    def debug(self, message: str, fields: Optional[Dict[str, Any]] = None) -> None:
        self._log(LogLevel.DEBUG, message, fields)

    def info(self, message: str, fields: Optional[Dict[str, Any]] = None) -> None:
        self._log(LogLevel.INFO, message, fields)

    def warn(self, message: str, fields: Optional[Dict[str, Any]] = None) -> None:
        self._log(LogLevel.WARN, message, fields)

    def error(self, message: str, fields: Optional[Dict[str, Any]] = None) -> None:
        self._log(LogLevel.ERROR, message, fields)

    def lines(self) -> List[str]:
        """Return all log entries as formatted strings."""
        with self._lock:
            return list(self._entries)

    def clear(self) -> None:
        """Reset the log buffer."""
        with self._lock:
            self._entries.clear()
