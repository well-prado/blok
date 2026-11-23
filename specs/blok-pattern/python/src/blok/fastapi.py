"""Puts every workflow that has an HTTP trigger on a FastAPI or Starlette app:

    app = FastAPI()
    blok_fastapi(app, load_app(Path(__file__).parent, ports=ports, env=os.environ))

The rest of the server stays yours.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.requests import Request
from starlette.responses import Response

from .http import answer
from .kernel import Log
from .project import App
from .workflow import HttpBinding

_PARAM = re.compile(r":([A-Za-z0-9_]+)")


def mount(
    app: Any,
    binding: HttpBinding,
    call: Callable[..., Awaitable[Any]],
    *,
    log: Log | None = None,
    now: Callable[[], float] | None = None,
) -> None:
    """Puts one route on the app. `blok_fastapi` calls it for every route of a project."""

    async def endpoint(request: Request) -> Response:
        # The body is read once, as it arrived, so a signed route can be checked against these very bytes.
        raw = await request.body()
        body: Any = {}
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                return _json(400, {"error": "invalid_input", "message": "The body is not JSON."})
        query: dict[str, Any] = {}
        for key in request.query_params.keys():
            values = request.query_params.getlist(key)
            query[key] = values[0] if len(values) == 1 else values
        asked = {
            "method": request.method,
            "body": body,
            "query": query,
            "params": dict(request.path_params),
            "headers": dict(request.headers),
        }
        status, payload = await answer(binding, call, asked, raw=raw, log=log, now=now)
        return _json(status, payload)

    path = _PARAM.sub(r"{\1}", binding.path)
    app.add_route(path, endpoint, methods=[binding.method], include_in_schema=False)


def _json(status: int, payload: Any) -> Response:
    content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return Response(content=content, status_code=status, media_type="application/json")


def blok_fastapi(app: Any, blok: App, *, now: Callable[[], float] | None = None) -> None:
    """Every workflow with an HTTP trigger becomes a route of `app`."""
    for binding in blok.bindings:
        if isinstance(binding, HttpBinding):
            mount(app, binding, blok.call, log=blok.log, now=now)
