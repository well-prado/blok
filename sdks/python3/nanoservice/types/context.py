from __future__ import annotations
from typing import Any, Dict, Optional


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

    __slots__ = ("id", "workflow_name", "workflow_path", "request", "response", "vars", "env")

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
