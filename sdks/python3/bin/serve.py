#!/usr/bin/env python3
"""Entry point for the Blok nanoservice Python3 runtime server.

Usage:
    python bin/serve.py

Environment variables:
    PORT          - HTTP port (default: 8080)
    HOST          - Bind address (default: 0.0.0.0)
    VERSION       - Runtime version (default: 1.0.0)
    LOG_LEVEL     - Log level: DEBUG, INFO, WARN, ERROR (default: INFO)
    ENABLE_CORS   - Enable CORS: true/false (default: false)
"""

import logging
import sys
import os

# Add the SDK root to the path so imports work
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nanoservice.node.node_registry import NodeRegistry
from nanoservice.server.runtime_server import RuntimeServer
from nanoservice.config.server_config import ServerConfig
from nanoservice.middleware.logging_middleware import logging_middleware
from nanoservice.middleware.recovery_middleware import recovery_middleware
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

    # Start serving
    server = RuntimeServer(registry, config)
    server.start()


if __name__ == "__main__":
    main()
