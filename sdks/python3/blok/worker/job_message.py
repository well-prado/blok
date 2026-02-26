from __future__ import annotations

from typing import Any, Dict, Optional


class JobMessage:
    """Represents a job received from a NATS worker queue.

    Mirrors the Go/Rust JobMessage struct.
    """

    __slots__ = ("id", "queue", "data", "headers", "attempt", "max_retries")

    def __init__(
        self,
        id: str = "",
        queue: str = "",
        data: Any = None,
        headers: Optional[Dict[str, str]] = None,
        attempt: int = 0,
        max_retries: int = 3,
    ):
        self.id = id
        self.queue = queue
        self.data = data
        self.headers = headers or {}
        self.attempt = attempt
        self.max_retries = max_retries

    def data_map(self) -> Optional[Dict[str, Any]]:
        """Return the job data as a dict, or None if not a dict."""
        if isinstance(self.data, dict):
            return self.data
        return None
