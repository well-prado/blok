# Blok Blok Python3 SDK
#
# This SDK enables building workflow nodes that integrate with the Blok
# orchestration framework. Nodes communicate via HTTP (POST /execute, GET /health)
# and can be deployed as Docker containers.

__version__ = "1.0.0"

from blok.types.context import Context, Request, Response
from blok.types.execution_request import ExecutionRequest, NodeConfig
from blok.types.execution_result import ExecutionResult, ExecutionMetrics
from blok.node.node_handler import NodeHandler
from blok.node.node_registry import NodeRegistry
from blok.server.runtime_server import RuntimeServer
from blok.config.server_config import ServerConfig
from blok.errors.blok_error import BlokError
from blok.errors.node_error import NodeError, ErrorCategory
from blok.logging.logger import Logger, LogLevel

__all__ = [
    "Context",
    "Request",
    "Response",
    "ExecutionRequest",
    "NodeConfig",
    "ExecutionResult",
    "ExecutionMetrics",
    "NodeHandler",
    "NodeRegistry",
    "RuntimeServer",
    "ServerConfig",
    # Preferred structured error API (master plan §17).
    "BlokError",
    # Legacy error type — kept for back-compat.
    "NodeError",
    "ErrorCategory",
    "Logger",
    "LogLevel",
]

# Worker (optional — requires nats-py)
try:
    from blok.worker import Worker, WorkerConfig, JobMessage, listen_and_serve_worker

    __all__ += ["Worker", "WorkerConfig", "JobMessage", "listen_and_serve_worker"]
except ImportError:
    pass
