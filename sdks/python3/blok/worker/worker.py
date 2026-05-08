"""NATS JetStream Worker for Blok.

Standalone background job processing using NATS JetStream.
Mirrors the Go (sdks/go/worker.go) and Rust (sdks/rust/src/worker.rs) workers.

Requires: pip install nats-py
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Awaitable, Callable, Dict, List, Optional

from blok.config.server_config import ServerConfig
from blok.node.node_registry import NodeRegistry
from blok.types.context import Context, Request, Response
from blok.types.execution_request import ExecutionRequest, NodeConfig
from blok.worker.job_message import JobMessage
from blok.worker.worker_config import WorkerConfig

logger = logging.getLogger("blok.worker")

# Type alias for async job handlers
JobHandler = Callable[[JobMessage], Awaitable[None]]


class Worker:
    """NATS JetStream worker that processes background jobs.

    Mirrors the Go/Rust Worker API:
        worker = Worker(registry, config)
        worker.handle("emails", my_handler)        # custom async handler
        worker.handle_node("emails", "send-email")  # auto-route to registry
        await worker.start()                         # connect + consume + block
        await worker.stop()                          # graceful shutdown
        await worker.dispatch("emails", {...})       # publish a job

    Example::

        from blok.worker import Worker, WorkerConfig
        from blok.node.node_registry import NodeRegistry

        config = WorkerConfig.from_env()
        registry = NodeRegistry(version=config.version)
        # register nodes...

        worker = Worker(registry, config)
        worker.handle_node("emails", "send-email")

        import asyncio
        asyncio.run(worker.start())
    """

    def __init__(self, registry: NodeRegistry, config: WorkerConfig):
        try:
            import nats  # noqa: F401
        except ImportError:
            raise ImportError(
                "nats-py is required for the worker. "
                "Install it with: pip install nats-py"
            )

        self._registry = registry
        self._config = config
        self._handlers: Dict[str, JobHandler] = {}
        self._nc: Any = None
        self._js: Any = None
        self._subscriptions: List[Any] = []
        self._tasks: List[asyncio.Task] = []
        self._executor = ThreadPoolExecutor(
            max_workers=config.concurrency,
            thread_name_prefix="blok-worker",
        )
        self._shutdown_event = asyncio.Event()

    def handle(self, queue: str, handler: JobHandler) -> None:
        """Register an async handler for a queue."""
        self._handlers[queue] = handler

    def handle_node(self, queue: str, node_name: str) -> None:
        """Register a handler that routes jobs to a registered node.

        The job data becomes the node's request body and config.
        Node execution runs in a thread executor (sync bridge).
        """
        registry = self._registry
        executor = self._executor

        async def _node_handler(job: JobMessage) -> None:
            data_map = job.data_map() or {}

            req = ExecutionRequest(
                node=NodeConfig(
                    name=node_name,
                    config=data_map,
                ),
                context=Context(
                    id=job.id,
                    request=Request(
                        body=job.data,
                        headers=job.headers,
                        params={
                            "queue": job.queue,
                            "jobId": job.id,
                            "attempt": str(job.attempt),
                        },
                    ),
                    vars={
                        "_worker_job": {
                            "id": job.id,
                            "queue": job.queue,
                            "attempts": str(job.attempt),
                            "maxRetries": str(job.max_retries),
                        },
                    },
                ),
            )

            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(executor, registry.execute, req)

            if not result.success:
                err_msg = "node execution failed"
                if isinstance(result.errors, dict) and "message" in result.errors:
                    err_msg = result.errors["message"]
                raise RuntimeError(err_msg)

        self._handlers[queue] = _node_handler

    async def start(self) -> None:
        """Connect to NATS, ensure streams/consumers, and start processing.

        Blocks until shutdown_event is set or a signal is received.
        """
        import nats

        connect_opts: Dict[str, Any] = {
            "servers": self._config.servers,
            "name": "blok-worker",
        }

        if self._config.token:
            connect_opts["token"] = self._config.token
        if self._config.user and self._config.password:
            connect_opts["user"] = self._config.user
            connect_opts["password"] = self._config.password

        self._nc = await nats.connect(**connect_opts)
        self._js = self._nc.jetstream()

        logger.info(
            "[Worker] Connected to NATS: %s",
            ", ".join(self._config.servers),
        )

        sem = asyncio.Semaphore(self._config.concurrency)

        for queue, handler in self._handlers.items():
            task = asyncio.create_task(self._consume_queue(queue, handler, sem))
            self._tasks.append(task)

        logger.info(
            "[Worker] Processing %d queue(s), concurrency=%d",
            len(self._handlers),
            self._config.concurrency,
        )

        await self._shutdown_event.wait()

        logger.info("[Worker] Shutting down...")
        await self.stop()

    async def stop(self) -> None:
        """Gracefully stop all consumers and disconnect from NATS."""
        for task in self._tasks:
            task.cancel()

        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        for psub in self._subscriptions:
            try:
                await psub.unsubscribe()
            except Exception as e:
                logger.warning("[Worker] Error unsubscribing: %s", e)
        self._subscriptions.clear()

        if self._nc and self._nc.is_connected:
            try:
                await self._nc.drain()
            except Exception as e:
                logger.warning("[Worker] Error draining NATS: %s", e)

        self._executor.shutdown(wait=False)
        logger.info("[Worker] Stopped")

    async def dispatch(
        self,
        queue: str,
        data: Any,
        *,
        job_id: str = "",
        priority: int = 0,
        delay_ms: int = 0,
        timeout_ms: int = 0,
    ) -> str:
        """Publish a job to a worker queue. Returns the job ID."""
        if self._nc is None or self._js is None:
            raise RuntimeError("Worker not connected. Call start() first.")

        subject = f"worker.{queue}"
        payload = json.dumps(data).encode("utf-8")

        if not job_id:
            job_id = f"job-{int(time.time() * 1_000_000)}"

        from nats.aio.msg import Msg

        headers = {
            "x-job-id": job_id,
            "Nats-Msg-Id": job_id,
        }
        if priority > 0:
            headers["x-priority"] = str(priority)
        if delay_ms > 0:
            headers["x-delay"] = str(delay_ms)
        if timeout_ms > 0:
            headers["x-timeout"] = str(timeout_ms)

        await self._js.publish(subject, payload, headers=headers)
        return job_id

    # ---- Internal methods ----

    async def _ensure_stream(self, stream_name: str) -> None:
        """Create the JetStream stream if it doesn't exist."""
        from nats.js.api import RetentionPolicy, StorageType

        try:
            await self._js.find_stream_name_by_subject("worker.>")
            logger.debug("[Worker] Stream already exists for worker.> subjects")
        except Exception:
            try:
                await self._js.add_stream(
                    name=stream_name,
                    subjects=["worker.>"],
                    retention=RetentionPolicy.WORK_QUEUE,
                    storage=StorageType.FILE,
                )
                logger.info("[Worker] Created JetStream stream: %s", stream_name)
            except Exception as e:
                err_str = str(e).lower()
                if "already" in err_str or "exists" in err_str or "in use" in err_str:
                    logger.debug("[Worker] Stream %s already exists", stream_name)
                else:
                    raise

    async def _consume_queue(
        self,
        queue: str,
        handler: JobHandler,
        sem: asyncio.Semaphore,
    ) -> None:
        """Continuously fetch and process messages for one queue."""
        from nats.js.api import AckPolicy, ConsumerConfig

        subject = f"worker.{queue}"
        stream_name = self._config.stream_name
        durable_name = f"blok-worker-{queue}"

        await self._ensure_stream(stream_name)

        ack_wait_with_buffer = self._config.ack_wait_secs + 5

        psub = await self._js.pull_subscribe(
            subject,
            durable=durable_name,
            config=ConsumerConfig(
                ack_policy=AckPolicy.EXPLICIT,
                max_deliver=self._config.max_retries + 1,
                ack_wait=ack_wait_with_buffer,
                filter_subject=subject,
            ),
        )
        self._subscriptions.append(psub)

        logger.info(
            "[Worker] Subscribed to queue: %s (stream=%s, consumer=%s)",
            queue,
            stream_name,
            durable_name,
        )

        while True:
            try:
                msgs = await psub.fetch(batch=self._config.concurrency, timeout=5)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                err_str = str(e).lower()
                if "timeout" not in err_str and "408" not in err_str:
                    logger.warning("[Worker] Fetch error on %s: %s", queue, e)
                continue

            for msg in msgs:
                async with sem:
                    await self._process_message(msg, queue, handler)

    async def _process_message(
        self,
        msg: Any,
        queue: str,
        handler: JobHandler,
    ) -> None:
        """Handle a single message from NATS."""
        headers: Dict[str, str] = {}
        if msg.headers:
            for key, value in msg.headers.items():
                if isinstance(value, list):
                    headers[key] = value[0] if value else ""
                else:
                    headers[key] = str(value)

        job_id = (
            headers.get("x-job-id")
            or headers.get("Nats-Msg-Id")
            or f"job-{int(time.time() * 1_000_000)}"
        )

        attempt = 0
        try:
            metadata = msg.metadata
            if metadata and metadata.num_delivered:
                attempt = max(0, metadata.num_delivered - 1)
        except Exception:
            pass

        try:
            data = json.loads(msg.data) if msg.data else None
        except (json.JSONDecodeError, ValueError):
            data = None

        job = JobMessage(
            id=job_id,
            queue=queue,
            data=data,
            headers=headers,
            attempt=attempt,
            max_retries=self._config.max_retries,
        )

        logger.info(
            "[Worker] Processing job %s from %s (attempt %d/%d)",
            job.id,
            queue,
            attempt + 1,
            self._config.max_retries + 1,
        )

        start_time = time.monotonic()
        try:
            await handler(job)
            elapsed = (time.monotonic() - start_time) * 1000
            logger.info("[Worker] Job %s completed in %.1fms", job.id, elapsed)
            await msg.ack()
        except Exception as e:
            elapsed = (time.monotonic() - start_time) * 1000
            logger.error(
                "[Worker] Job %s failed after %.1fms: %s", job.id, elapsed, e
            )
            try:
                await msg.nak()
            except Exception as nak_err:
                logger.error("[Worker] Failed to nak message: %s", nak_err)


def listen_and_serve_worker(registry: NodeRegistry) -> None:
    """Convenience function that creates a worker, auto-registers nodes,
    starts processing, and runs an HTTP health server alongside.

    Mirrors Go's ListenAndServeWorker().
    """
    config = WorkerConfig.from_env()

    worker = Worker(registry, config)

    if config.queues:
        for queue in config.queues:
            worker.handle_node(queue, queue)
        logger.info(
            "[Worker] Auto-registered %d queue(s): %s",
            len(config.queues),
            ", ".join(config.queues),
        )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    _start_health_server(registry, config)

    def _signal_handler() -> None:
        logger.info("[Worker] Shutdown signal received")
        worker._shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    try:
        loop.run_until_complete(worker.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


def _start_health_server(registry: NodeRegistry, config: WorkerConfig) -> None:
    """Start an HTTP health server in a daemon thread."""

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return

            health = registry.health()
            body = json.dumps(health.to_dict()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: Any) -> None:
            pass  # Suppress default request logging

    server = HTTPServer(("0.0.0.0", config.health_port), HealthHandler)

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    logger.info("[Worker] Health server started on 0.0.0.0:%d", config.health_port)
