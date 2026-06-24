#!/usr/bin/env python3
"""Entry point for the Blok blok Python3 runtime server.

Usage:
    python bin/serve.py

Environment variables:
    PORT             HTTP port (default: 9007)
    HOST             Bind address (default: 0.0.0.0)
    VERSION          Runtime version (default: 1.0.0)
    GRPC_PORT        gRPC port (default: 10007)
    BLOK_TRANSPORT   "http" | "grpc" | "both" (default: "http")
    LOG_LEVEL        DEBUG | INFO | WARN | ERROR (default: INFO)
    ENABLE_CORS      true / false (default: false)
    BLOK_GRPC_MAX_MESSAGE_BYTES  Max gRPC message size, send+recv (default: 16777216).
                     Must match the runner client + other sidecars.
    BLOK_NODES_DIR   Directory of user-authored nodes to discover (each node in
                     a `<name>/node.py` using the `@node` decorator). Set by
                     blokctl to the project's `runtimes/python3/nodes`. When
                     unset, only the SDK's built-in example nodes load.
"""

import logging
import os
import signal
import sys
import threading

# Add the SDK root to the path so imports work
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from blok.config.server_config import ServerConfig
from blok.middleware.logging_middleware import logging_middleware
from blok.middleware.recovery_middleware import recovery_middleware
from blok.node.node_registry import NodeRegistry
from blok.server.runtime_server import RuntimeServer
from examples import register_all


def _start_http(registry: NodeRegistry, config: ServerConfig) -> RuntimeServer:
    """Start the HTTP runtime server in the calling thread.

    Returns the started server so the caller can stop it cleanly.
    """
    server = RuntimeServer(registry, config)
    server.start()
    return server


def _start_grpc(registry: NodeRegistry, config: ServerConfig):
    """Start the gRPC runtime server. Lazy-imports grpcio so the base SDK
    install doesn't pull it in unless `BLOK_TRANSPORT` selects gRPC.

    Returns the started ``grpc.Server`` instance.
    """
    try:
        from blok.server.grpc_server import serve_grpc
    except ImportError as exc:  # pragma: no cover — depends on optional install
        logging.error(
            "BLOK_TRANSPORT=%s requires grpcio. Install with: pip install 'blok-blok-python3[grpc]'",
            config.transport,
        )
        raise SystemExit(1) from exc

    # Max gRPC message size (decode + encode), default 16 MiB. MUST match the
    # runner client's BLOK_GRPC_MAX_MESSAGE_BYTES and the other sidecars — a
    # client-only raise leaves this server rejecting oversized messages with
    # RESOURCE_EXHAUSTED. Invalid / non-positive falls back to the default.
    default_max = 16 * 1024 * 1024
    try:
        max_message_bytes = int(os.environ.get("BLOK_GRPC_MAX_MESSAGE_BYTES", default_max))
        if max_message_bytes <= 0:
            max_message_bytes = default_max
    except (TypeError, ValueError):
        max_message_bytes = default_max

    return serve_grpc(
        registry,
        port=config.grpc_port,
        host=config.host,
        sdk_version=config.version,
        max_message_bytes=max_message_bytes,
    )


def _load_user_nodes(registry: NodeRegistry) -> int:
    """Discover user nodes from ``BLOK_NODES_DIR`` (delegates to the SDK).

    `@node` authoring requires pydantic; if it isn't installed there are no
    user nodes to load, so a missing import is a no-op.
    """
    try:
        from blok.node.define_node import load_user_nodes
    except ImportError:
        return 0
    return load_user_nodes(registry, os.environ.get("BLOK_NODES_DIR"))


def main():
    config = ServerConfig.from_env()

    log_level = getattr(logging, config.log_level, logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stdout,
    )

    registry = NodeRegistry(version=config.version)
    register_all(registry)
    user_node_count = _load_user_nodes(registry)
    registry.use(recovery_middleware)
    registry.use(logging_middleware)

    transport = config.transport
    log = logging.getLogger("blok.serve")
    log.info(
        "Blok Python3 SDK starting (transport=%s, http_port=%d, grpc_port=%d, %d nodes, %d user)",
        transport,
        config.port,
        config.grpc_port,
        len(registry.node_names()),
        user_node_count,
    )

    if transport == "http":
        _start_http(registry, config)
        return

    if transport == "grpc":
        grpc_server = _start_grpc(registry, config)
        _block_until_signal_then_stop(grpc=grpc_server, http=None)
        return

    if transport == "both":
        # Start gRPC in background, HTTP in foreground (HTTP server's
        # ``start()`` blocks until shutdown). On signal we stop gRPC, then
        # the HTTP server unwinds.
        grpc_server = _start_grpc(registry, config)
        http_thread = threading.Thread(
            target=_start_http,
            args=(registry, config),
            daemon=True,
            name="blok-http",
        )
        http_thread.start()
        _block_until_signal_then_stop(grpc=grpc_server, http=None)
        return

    log.error("Unknown BLOK_TRANSPORT=%r — expected http | grpc | both", transport)
    sys.exit(1)


def _block_until_signal_then_stop(*, grpc, http) -> None:
    """Block on SIGINT/SIGTERM, then stop the gRPC server (and HTTP if owned)."""
    stop_event = threading.Event()

    def _handler(signum, _frame):
        logging.getLogger("blok.serve").info("Received signal %d, shutting down…", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)
    stop_event.wait()

    if grpc is not None:
        grpc.stop(grace=3.0)
    # The HTTP server in dual-listen runs in a daemon thread; it tears down
    # automatically on process exit. ``http`` is reserved for future shapes
    # (e.g. promoting HTTP into a stoppable abstraction).


if __name__ == "__main__":
    main()
