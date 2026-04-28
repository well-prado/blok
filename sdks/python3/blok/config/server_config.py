from __future__ import annotations
import os


class ServerConfig:
    """Configuration for the blok HTTP server.

    All values can be overridden via environment variables.

    Environment variables:
        PORT: HTTP port (default: 9007)
        HOST: Bind address (default: 0.0.0.0)
        VERSION: Runtime version (default: 1.0.0)
        GRPC_PORT: gRPC port (default: 10007 — matches runner's
                   DEFAULT_GRPC_PORTS.python3 = HTTP+1000)
        BLOK_TRANSPORT: Transport selector. One of "http", "grpc", "both"
                        (default: "http"). When "grpc" or "both" the SDK
                        starts a gRPC server on GRPC_PORT.
        READ_TIMEOUT: Read timeout in seconds (default: 30)
        WRITE_TIMEOUT: Write timeout in seconds (default: 30)
        SHUTDOWN_TIMEOUT: Shutdown timeout in seconds (default: 10)
        LOG_LEVEL: Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)
        ENABLE_CORS: Enable CORS: true/false (default: false)
    """

    def __init__(
        self,
        port: int = 9007,
        host: str = "0.0.0.0",
        version: str = "1.0.0",
        grpc_port: int = 10007,
        transport: str = "http",
        read_timeout_sec: int = 30,
        write_timeout_sec: int = 30,
        shutdown_timeout_sec: int = 10,
        log_level: str = "INFO",
        enable_cors: bool = False,
    ):
        self.port = port
        self.host = host
        self.version = version
        self.grpc_port = grpc_port
        self.transport = transport
        self.read_timeout_sec = read_timeout_sec
        self.write_timeout_sec = write_timeout_sec
        self.shutdown_timeout_sec = shutdown_timeout_sec
        self.log_level = log_level
        self.enable_cors = enable_cors

    @property
    def address(self) -> str:
        return f"{self.host}:{self.port}"

    @classmethod
    def from_env(cls) -> ServerConfig:
        """Load configuration from environment variables."""
        cfg = cls()

        if v := os.environ.get("PORT"):
            try:
                port = int(v)
                if port > 0:
                    cfg.port = port
            except ValueError:
                pass

        if v := os.environ.get("HOST"):
            cfg.host = v

        if v := os.environ.get("VERSION"):
            cfg.version = v

        if v := os.environ.get("GRPC_PORT"):
            try:
                gport = int(v)
                if gport > 0:
                    cfg.grpc_port = gport
            except ValueError:
                pass

        if v := os.environ.get("BLOK_TRANSPORT"):
            if v in ("http", "grpc", "both"):
                cfg.transport = v

        if v := os.environ.get("READ_TIMEOUT"):
            try:
                t = int(v)
                if t > 0:
                    cfg.read_timeout_sec = t
            except ValueError:
                pass

        if v := os.environ.get("WRITE_TIMEOUT"):
            try:
                t = int(v)
                if t > 0:
                    cfg.write_timeout_sec = t
            except ValueError:
                pass

        if v := os.environ.get("SHUTDOWN_TIMEOUT"):
            try:
                t = int(v)
                if t > 0:
                    cfg.shutdown_timeout_sec = t
            except ValueError:
                pass

        if v := os.environ.get("LOG_LEVEL"):
            if v in ("DEBUG", "INFO", "WARN", "ERROR"):
                cfg.log_level = v

        if os.environ.get("ENABLE_CORS") in ("true", "1"):
            cfg.enable_cors = True

        return cfg
