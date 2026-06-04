from __future__ import annotations
from typing import Any, Callable, Dict, Optional


class Request:
    """Represents the incoming HTTP request data."""

    __slots__ = ("body", "headers", "params", "query", "method", "url", "cookies", "base_url")

    def __init__(
        self,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, str]] = None,
        query: Optional[Dict[str, str]] = None,
        method: str = "",
        url: str = "",
        cookies: Optional[Dict[str, str]] = None,
        base_url: str = "",
    ):
        self.body = body
        self.headers = headers or {}
        self.params = params or {}
        self.query = query or {}
        self.method = method
        self.url = url
        self.cookies = cookies or {}
        self.base_url = base_url

    def body_map(self) -> Optional[Dict[str, Any]]:
        """Return the request body as a dict, or None if not a dict."""
        if isinstance(self.body, dict):
            return self.body
        return None

    def body_str(self, key: str, default: str = "") -> str:
        """Get a string value from the body dict."""
        body = self.body_map()
        if body is None:
            return default
        val = body.get(key)
        return str(val) if val is not None else default

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Request:
        return cls(
            body=data.get("body"),
            headers=data.get("headers", {}),
            params=data.get("params", {}),
            query=data.get("query", {}),
            method=data.get("method", ""),
            url=data.get("url", ""),
            cookies=data.get("cookies", {}),
            base_url=data.get("baseUrl", ""),
        )


class Response:
    """Represents the workflow response."""

    __slots__ = ("data", "content_type", "success", "error")

    def __init__(
        self,
        data: Any = None,
        content_type: str = "application/json",
        success: bool = True,
        error: Any = None,
    ):
        self.data = data
        self.content_type = content_type
        self.success = success
        self.error = error

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Response:
        return cls(
            data=data.get("data"),
            content_type=data.get("contentType", "application/json"),
            success=data.get("success", True),
            error=data.get("error"),
        )


class Context:
    """Represents the workflow execution context passed between nodes."""

    __slots__ = ("id", "workflow_name", "workflow_path", "request", "response", "vars", "env", "_emit_sink")

    def __init__(
        self,
        id: str = "",
        workflow_name: str = "",
        workflow_path: str = "",
        request: Optional[Request] = None,
        response: Optional[Response] = None,
        vars: Optional[Dict[str, Any]] = None,
        env: Optional[Dict[str, str]] = None,
    ):
        self.id = id
        self.workflow_name = workflow_name
        self.workflow_path = workflow_path
        self.request = request or Request()
        self.response = response or Response()
        self.vars = vars if vars is not None else {}
        self.env = env if env is not None else {}
        # Set by the gRPC server during ``ExecuteStream`` so ``emit()`` can
        # push live data events back to the runner. ``None`` under the unary
        # ``Execute`` path (and any non-streaming caller) — ``emit()`` is then
        # a no-op, so node code can call it unconditionally.
        self._emit_sink: Optional[Callable[[Any], None]] = None

    def emit(self, snapshot: Any) -> None:
        """Emit a live intermediate event while the node is still running.

        Under an ``ExecuteStream`` call (a workflow step with
        ``streamTo: "sse"`` / ``stream: true``), each ``emit(...)`` is sent to
        the runner as a ``PartialResult`` frame AS IT HAPPENS — before this
        node returns its terminal result. The runner forwards it to the SSE
        client live. Use it to stream tokens, tool-calls, or discovered
        sources from a long-running agent::

            def execute(ctx, config):
                ctx.emit({"event": "text", "data": {"delta": "Hel"}, "id": "1"})
                ctx.emit({"event": "source", "data": {"url": "..."}, "id": "2"})
                return {"answer": "Hello", "sources": [...]}

        ``snapshot`` is any JSON-serializable value. Emit a framed object
        ``{"event": str, "data": Any, "id": str?, "retry": int?}`` to name the
        SSE event yourself (the producer holds the semantic context); any other
        value becomes the frame ``data`` with no explicit event name.

        A no-op when the node runs under the unary ``Execute`` path (no SSE
        sink installed), so the same handler works in both modes.
        """
        sink = self._emit_sink
        if sink is not None:
            sink(snapshot)

    def _set_emit_sink(self, sink: Optional[Callable[[Any], None]]) -> None:
        """Install (or clear) the live-emit sink. Called by the gRPC server."""
        self._emit_sink = sink

    def set_var(self, key: str, value: Any) -> None:
        """Store a variable in the context for downstream nodes."""
        self.vars[key] = value

    def get_var(self, key: str, default: Any = None) -> Any:
        """Retrieve a variable from the context."""
        return self.vars.get(key, default)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Context:
        return cls(
            id=data.get("id", ""),
            workflow_name=data.get("workflow_name", ""),
            workflow_path=data.get("workflow_path", ""),
            request=Request.from_dict(data.get("request", {})),
            response=Response.from_dict(data.get("response", {})),
            vars=data.get("vars", {}),
            env=data.get("env", {}),
        )
