#!/usr/bin/env python3
"""Entry point for the Blok NATS JetStream worker.

Usage:
    python bin/worker.py

Environment variables:
    NATS_SERVERS          - Comma-separated NATS server URLs (default: localhost:4222)
    NATS_TOKEN            - Authentication token (optional)
    NATS_USER             - Username (optional)
    NATS_PASS             - Password (optional)
    NATS_STREAM_NAME      - JetStream stream name (default: blok-worker)
    WORKER_CONCURRENCY    - Max concurrent jobs (default: 1)
    WORKER_MAX_RETRIES    - Max delivery attempts (default: 3)
    WORKER_ACK_WAIT_SECS  - Job timeout in seconds (default: 30)
    WORKER_QUEUES         - Comma-separated queue names
    PORT                  - HTTP health server port (default: 8080)
    VERSION               - Runtime version (default: 1.0.0)
    LOG_LEVEL             - Log level: DEBUG, INFO, WARN, ERROR (default: INFO)
"""

import logging
import os
import sys

# Add the SDK root to the path so imports work
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from blok.config.server_config import ServerConfig
from blok.middleware.logging_middleware import logging_middleware
from blok.middleware.recovery_middleware import recovery_middleware
from blok.node.node_registry import NodeRegistry
from blok.worker import listen_and_serve_worker
from examples import register_all


def main():
    # Configure logging
    config = ServerConfig.from_env()
    log_level = getattr(logging, config.log_level, logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stdout,
    )

    # Create registry and register nodes
    registry = NodeRegistry(version=config.version)
    register_all(registry)

    # Add middleware
    registry.use(recovery_middleware)
    registry.use(logging_middleware)

    # Start worker (blocks until shutdown)
    listen_and_serve_worker(registry)


if __name__ == "__main__":
    main()
