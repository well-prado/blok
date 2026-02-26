from __future__ import annotations

import os
from typing import List, Optional


class WorkerConfig:
    """Configuration for the NATS JetStream worker.

    Environment variables:
        NATS_SERVERS:          Comma-separated NATS server URLs (default: localhost:4222)
        NATS_TOKEN:            Authentication token (optional)
        NATS_USER:             Username (optional)
        NATS_PASS:             Password (optional)
        NATS_STREAM_NAME:      JetStream stream name (default: blok-worker)
        WORKER_CONCURRENCY:    Max concurrent jobs (default: 1)
        WORKER_MAX_RETRIES:    Max delivery attempts (default: 3)
        WORKER_ACK_WAIT_SECS:  Job timeout in seconds (default: 30)
        WORKER_QUEUES:         Comma-separated queue names
        PORT:                  HTTP health server port (default: 8080)
        VERSION:               Runtime version (default: 1.0.0)
    """

    __slots__ = (
        "servers",
        "stream_name",
        "version",
        "token",
        "user",
        "password",
        "concurrency",
        "max_retries",
        "ack_wait_secs",
        "queues",
        "health_port",
    )

    def __init__(
        self,
        servers: Optional[List[str]] = None,
        stream_name: str = "blok-worker",
        version: str = "1.0.0",
        token: str = "",
        user: str = "",
        password: str = "",
        concurrency: int = 1,
        max_retries: int = 3,
        ack_wait_secs: int = 30,
        queues: Optional[List[str]] = None,
        health_port: int = 8080,
    ):
        self.servers = servers or ["localhost:4222"]
        self.stream_name = stream_name
        self.version = version
        self.token = token
        self.user = user
        self.password = password
        self.concurrency = concurrency
        self.max_retries = max_retries
        self.ack_wait_secs = ack_wait_secs
        self.queues = queues or []
        self.health_port = health_port

    @classmethod
    def from_env(cls) -> WorkerConfig:
        """Load configuration from environment variables."""
        servers = ["localhost:4222"]
        if v := os.environ.get("NATS_SERVERS"):
            servers = [s.strip() for s in v.split(",") if s.strip()]

        stream_name = os.environ.get("NATS_STREAM_NAME", "blok-worker")
        version = os.environ.get("VERSION", "1.0.0")
        token = os.environ.get("NATS_TOKEN", "")
        user = os.environ.get("NATS_USER", "")
        password = os.environ.get("NATS_PASS", "")

        concurrency = 1
        if v := os.environ.get("WORKER_CONCURRENCY"):
            try:
                n = int(v)
                if n > 0:
                    concurrency = n
            except ValueError:
                pass

        max_retries = 3
        if v := os.environ.get("WORKER_MAX_RETRIES"):
            try:
                n = int(v)
                if n >= 0:
                    max_retries = n
            except ValueError:
                pass

        ack_wait_secs = 30
        if v := os.environ.get("WORKER_ACK_WAIT_SECS"):
            try:
                n = int(v)
                if n > 0:
                    ack_wait_secs = n
            except ValueError:
                pass

        queues: List[str] = []
        if v := os.environ.get("WORKER_QUEUES"):
            queues = [q.strip() for q in v.split(",") if q.strip()]

        health_port = 8080
        if v := os.environ.get("PORT"):
            try:
                n = int(v)
                if n > 0:
                    health_port = n
            except ValueError:
                pass

        return cls(
            servers=servers,
            stream_name=stream_name,
            version=version,
            token=token,
            user=user,
            password=password,
            concurrency=concurrency,
            max_retries=max_retries,
            ack_wait_secs=ack_wait_secs,
            queues=queues,
            health_port=health_port,
        )
