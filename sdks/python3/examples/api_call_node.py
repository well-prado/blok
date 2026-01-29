from __future__ import annotations
import json
import urllib.request
import urllib.error
from typing import Any, Dict

from nanoservice.node.node_handler import NodeHandler
from nanoservice.types.context import Context
from nanoservice.errors.node_error import NodeError


class ApiCallNode(NodeHandler):
    """Makes HTTP requests to external APIs.

    Config:
        url (str, required): The URL to call
        method (str, optional): HTTP method (default: "GET")
        timeout (int, optional): Timeout in seconds (default: 10)
        headers (dict, optional): Additional request headers

    Request body:
        body (object, optional): Request body for POST/PUT/PATCH

    Output:
        {"status": 200, "data": {...}, "headers": {...}}
    """

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        url = config.get("url")
        if not url:
            raise NodeError.configuration("'url' is required in node config")

        method = (config.get("method") or "GET").upper()
        timeout = config.get("timeout", 10)

        # Build request
        req_body = None
        if method in ("POST", "PUT", "PATCH"):
            body_map = ctx.request.body_map()
            if body_map and "body" in body_map:
                req_body = json.dumps(body_map["body"]).encode("utf-8")

        req = urllib.request.Request(url, data=req_body, method=method)
        req.add_header("Content-Type", "application/json")

        # Add configured headers
        extra_headers = config.get("headers")
        if isinstance(extra_headers, dict):
            for k, v in extra_headers.items():
                req.add_header(k, str(v))

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp_body = resp.read().decode("utf-8")
                try:
                    data = json.loads(resp_body)
                except (json.JSONDecodeError, ValueError):
                    data = resp_body

                headers = {k: v for k, v in resp.getheaders()}

                return {
                    "status": resp.status,
                    "data": data,
                    "headers": headers,
                }
        except urllib.error.HTTPError as e:
            resp_body = e.read().decode("utf-8") if e.fp else ""
            try:
                data = json.loads(resp_body)
            except (json.JSONDecodeError, ValueError):
                data = resp_body
            return {
                "status": e.code,
                "data": data,
                "headers": {},
            }
        except Exception as e:
            raise NodeError.network(f"request to {url} failed: {e}", cause=e)
