from __future__ import annotations
import json
import logging
import signal
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

from blok.node.node_registry import NodeRegistry
from blok.config.server_config import ServerConfig
from blok.types.execution_request import ExecutionRequest
from blok.types.execution_result import ExecutionResult

logger = logging.getLogger("blok")


class _RequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the blok runtime."""

    registry: NodeRegistry
    config: ServerConfig

    def do_POST(self) -> None:
        if self.path != "/execute":
            self._write_json(
                404,
                ExecutionResult.error_result(f"not found: {self.path}").to_dict(),
            )
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            parsed = json.loads(body)
        except (json.JSONDecodeError, ValueError) as e:
            self._write_json(
                400,
                ExecutionResult.error_result(f"invalid JSON: {e}").to_dict(),
            )
            return

        execution_request = ExecutionRequest.from_dict(parsed)
        result = self.registry.execute(execution_request)
        self._write_json(200, result.to_dict())

    def do_GET(self) -> None:
        if self.path != "/health":
            self._write_json(404, {"error": f"not found: {self.path}"})
            return

        health = self.registry.health()
        self._write_json(200, health.to_dict())

    def _write_json(self, status_code: int, data: dict) -> None:
        response_body = json.dumps(data).encode("utf-8")

        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))

        if self.config.enable_cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

        self.end_headers()
        self.wfile.write(response_body)

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests."""
        self.send_response(204)
        if self.config.enable_cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def log_message(self, format: str, *args) -> None:
        """Override to use Python logging instead of stderr."""
        logger.debug("%s %s", self.address_string(), format % args)


class RuntimeServer:
    """Blok HTTP server that handles execute and health requests.

    This server exposes two endpoints matching the Blok SDK contract:

    - ``POST /execute`` - Execute a node with the provided ExecutionRequest JSON
    - ``GET /health``   - Return runtime health status

    Usage::

        registry = NodeRegistry()
        registry.register("my-node", MyNode())

        server = RuntimeServer(registry)
        server.start()  # blocks until shutdown
    """

    def __init__(
        self,
        registry: NodeRegistry,
        config: Optional[ServerConfig] = None,
    ):
        self.registry = registry
        self.config = config or ServerConfig.from_env()
        self._server: Optional[HTTPServer] = None

    def start(self) -> None:
        """Start the HTTP server. Blocks until shutdown."""
        handler_class = type(
            "Handler",
            (_RequestHandler,),
            {"registry": self.registry, "config": self.config},
        )

        self._server = HTTPServer(
            (self.config.host, self.config.port),
            handler_class,
        )
        self._server.timeout = self.config.read_timeout_sec

        # Set up graceful shutdown.
        # NOTE: We use sys.exit() instead of self._server.shutdown() because
        # shutdown() must be called from a different thread than serve_forever().
        # Calling it from a signal handler in the same thread causes a deadlock.
        def shutdown_handler(signum, frame):
            logger.info("Shutdown signal received, stopping server...")
            sys.exit(0)

        signal.signal(signal.SIGTERM, shutdown_handler)
        signal.signal(signal.SIGINT, shutdown_handler)

        logger.info(
            "Blok runtime v%s starting on %s",
            self.config.version,
            self.config.address,
        )
        logger.info("Registered nodes: %s", self.registry.node_names())

        try:
            self._server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            self._server.server_close()
            logger.info("Server stopped.")

    def shutdown(self) -> None:
        """Gracefully shut down the server."""
        if self._server:
            self._server.shutdown()
