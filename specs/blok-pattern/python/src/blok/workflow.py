"""Runs a workflow: the JSON that `blokctl build` wrote.

Values are plain strings, and `${step.field}` reads what an earlier step produced. Nothing is evaluated as code.
This file runs workflows and does not check them. The check is in `blokctl`, and what it learned about each
workflow arrives here as the `request` shape.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections import ChainMap
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .kernel import BlokError, Unit, WorkflowCtx, define_unit, number_text, whole

Json = Any
Path = list[str]


class _Absent:
    """A field that is not there. Not the same as null: a node's default applies to it, and JSON leaves it out."""

    def __repr__(self) -> str:
        return "MISSING"


MISSING: Any = _Absent()
_NOTHING: Any = object()  # No step has run yet, or several just ran at once.

# ---- strings ----------------------------------------------------------------------------

_TOKEN = re.compile(r"\$\$\{|\$\{([^}]*)\}")
_PATH = re.compile(r"[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*")
_CONDITION = re.compile(r"\s*\$\{([^}]*)\}\s*(?:(==|!=|>=|<=|>|<)\s*(.+?))?\s*")
_REF = re.compile(r"\$\{([^}]*)\}")
_QUOTED = re.compile(r"'([^']*)'|\"([^\"]*)\"")
_NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")
_WORD = re.compile(r"[A-Za-z0-9_-]+")


def _path(inside: str) -> Path:
    trimmed = inside.strip()
    if not _PATH.fullmatch(trimmed):
        raise ValueError(f'"${{{inside}}}" is not a path. Only a path such as ${{order.items}} can go inside ${{ }}.')
    return trimmed.split(".")


_parsed: dict[str, list[str | Path]] = {}


def _parts(text: str) -> list[str | Path]:
    """Splits "order ${order.id}" into text and paths. "$${" is a literal "${"."""
    known = _parsed.get(text)
    if known is not None:
        return known
    out: list[str | Path] = []
    last = 0
    for match in _TOKEN.finditer(text):
        if match.start() > last:
            out.append(text[last : match.start()])
        out.append("${" if match.group(0) == "$${" else _path(match.group(1)))
        last = match.end()
    if last < len(text):
        out.append(text[last:])
    _parsed[text] = out
    return out


@dataclass(frozen=True)
class _Condition:
    left: Path
    op: str | None = None
    right_path: Path | None = None
    right_value: Any = None


def _condition(text: str) -> _Condition:
    match = _CONDITION.fullmatch(text)
    if not match:
        raise ValueError(
            f'"{text}" is not a condition. Write ${{a.b}}, or ${{a.b}} followed by == != > >= < <= and a value.'
        )
    left = _path(match.group(1))
    if not match.group(2):
        return _Condition(left)
    raw = match.group(3)
    ref = _REF.fullmatch(raw)
    if ref:
        return _Condition(left, match.group(2), right_path=_path(ref.group(1)))
    quoted = _QUOTED.fullmatch(raw)
    value: Any
    if quoted:
        value = quoted.group(1) if quoted.group(1) is not None else quoted.group(2)
    elif _NUMBER.fullmatch(raw):
        value = whole(float(raw))
    elif raw in ("true", "false"):
        value = raw == "true"
    elif raw == "null":
        value = None
    elif _WORD.fullmatch(raw):
        value = raw
    else:
        raise ValueError(
            f'"{text}": "{raw}" is not a value. Use a number, true, false, null, a word or \'quoted text\'.'
        )
    return _Condition(left, match.group(2), right_value=value)


def _json_text(value: Any) -> str:
    """A value as JSON text with no spaces, the way every kernel writes it inside a string."""
    if value is None or value is MISSING:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return f"[{','.join(_json_text(inner) for inner in value)}]"
    if isinstance(value, Mapping):
        fields = (f"{json.dumps(str(key), ensure_ascii=False)}:{_json_text(inner)}" for key, inner in value.items())
        return f"{{{','.join(fields)}}}"
    return json.dumps(str(value), ensure_ascii=False)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else _json_text(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _same(a: Any, b: Any) -> bool:
    """Equal means the same kind and the same value: text is not a number, and 1 is not true."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    # Nothing, null, a list or an object: only the very same one.
    return a is b


# ---- the request ------------------------------------------------------------------------

_DECIMAL = re.compile(r"[+-]?([0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)")
_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")


def _number(text: str) -> int | float | None:
    """Text as a number, when it reads as one: "3", " 12 ", "1e3", ".5", "0x10". Nothing otherwise."""
    trimmed = text.strip()
    if _RADIX.fullmatch(trimmed):
        return int(trimmed, 0)
    if not _DECIMAL.fullmatch(trimmed):
        return None
    value = float(trimmed)
    return whole(value) if math.isfinite(value) else None


def _typed(value: Any, shape: Any) -> Any:
    """A query string, a path parameter and a header always arrive as text. Where a step needs a number or
    true/false, text that reads as one becomes one. Anything else is left as it came, for the node to refuse."""
    kind = shape.get("type") if isinstance(shape, dict) and isinstance(shape.get("type"), str) else None
    if kind == "array":
        items = shape.get("items")
        return [_typed(one, items) for one in (value if isinstance(value, list) else [value])]
    if not isinstance(value, str):
        return value
    if kind in ("integer", "number"):
        number = _number(value)
        if number is not None:
            return number
    if kind == "boolean" and value in ("true", "false"):
        return value == "true"
    return value


_TEXT_PARTS = ("query", "params", "headers")


def _request_of(given: Any, shape: Any) -> dict[str, Any]:
    """The request a workflow runs on. Every trigger hands over a body. Only HTTP has the other three parts,
    so they are empty for a schedule, a queue message, a tool call and a workflow used as a step."""
    request: dict[str, Any] = {"body": {}, "query": {}, "params": {}, "headers": {}}
    if isinstance(given, Mapping):
        request.update(whole(dict(given)))
    properties = shape.get("properties", {}) if isinstance(shape, dict) else {}
    for part in _TEXT_PARTS:
        wanted = (properties.get(part) or {}).get("properties")
        values = request[part]
        if not wanted or not isinstance(values, dict):
            continue
        request[part] = {key: _typed(inner, wanted[key]) if key in wanted else inner for key, inner in values.items()}
    return request


def _required_paths(shape: Any, prefix: Path | None = None) -> list[Path]:
    """Every path that is required all the way down from the root."""
    out: list[Path] = []
    if not isinstance(shape, dict):
        return out
    for field in shape.get("required", []):
        here = [*(prefix or []), field]
        deeper = _required_paths((shape.get("properties") or {}).get(field), here)
        out.extend(deeper if deeper else [here])
    return out


def _dig(value: Any, target: Path) -> Any:
    for field in target:
        value = value.get(field, MISSING) if isinstance(value, dict) else MISSING
    return value


# ---- run --------------------------------------------------------------------------------

Call = Callable[..., Awaitable[Any]]
Scope = ChainMap[str, Any]


async def _map_limit(items: list[Any], limit: int, fn: Callable[[Any], Awaitable[Any]]) -> list[Any]:
    results: list[Any] = [None] * len(items)
    state = {"next": 0, "failed": False}

    async def worker() -> None:
        # After a failure nothing new is started, and what is already running is left to finish.
        while state["next"] < len(items) and not state["failed"]:
            index = state["next"]
            state["next"] += 1
            try:
                results[index] = await fn(items[index])
            except BaseException:
                state["failed"] = True
                raise

    workers = [worker() for _ in range(max(1, min(limit, len(items))))]
    for end in await asyncio.gather(*workers, return_exceptions=True):
        if isinstance(end, BaseException):
            raise end
    return results


def workflow_unit(
    id: str,
    workflow: Mapping[str, Any],
    units: Mapping[str, Unit],
    *,
    is_workflow: Callable[[str], bool] | None = None,
    env: Mapping[str, Any] | None = None,
    request: Any = None,
) -> Unit:
    """Turns a workflow into a unit, so the kernel can run it, trace it and bind it like any node.

    `request` is what the workflow reads from its request, as the check derived it. A request that lacks a
    field a step is certain to need is refused before any step runs.
    """
    needed = _required_paths(request)
    surroundings = dict(env or {})

    def fail(code: str, message: str) -> BlokError:
        return BlokError(code, message, id)

    def shown(target: Path) -> str:
        return f'"${{{".".join(target)}}}"'

    def read(target: Path, scope: Scope) -> Any:
        root, *fields = target
        if root not in scope or scope[root] is _NOTHING:
            raise fail("workflow_ref", f"{shown(target)} is not available at this point.")
        value = scope[root]
        for field in fields:
            if isinstance(value, dict):
                value = value.get(field, MISSING)
            elif isinstance(value, list):
                index = int(field) if field.isascii() and field.isdigit() and str(int(field)) == field else -1
                value = value[index] if 0 <= index < len(value) else MISSING
            else:
                raise fail("workflow_ref", f'{shown(target)} has nothing at "{field}".')
        return value

    def render(value: Json, scope: Scope) -> Any:
        if isinstance(value, str):
            pieces = _parts(value)
            # A string that is one placeholder and nothing else keeps the value's own kind.
            if len(pieces) == 1 and not isinstance(pieces[0], str):
                return read(pieces[0], scope)
            out = []
            for piece in pieces:
                if isinstance(piece, str):
                    out.append(piece)
                    continue
                found = read(piece, scope)
                if found is None or found is MISSING:
                    raise fail("workflow_ref", f'"{value}" has an empty placeholder.')
                out.append(_text(found))
            return "".join(out)
        if isinstance(value, list):
            return [None if (inner := render(entry, scope)) is MISSING else inner for entry in value]
        if isinstance(value, dict):
            # A field with nothing in it is left out, so the node's default applies.
            return {key: inner for key, entry in value.items() if (inner := render(entry, scope)) is not MISSING}
        return value

    def holds(text: str, scope: Scope) -> bool:
        parsed = _condition(text)
        a = read(parsed.left, scope)
        if parsed.op is None:
            if not isinstance(a, bool):
                raise fail("workflow_if", f'"{text}" is not true or false.')
            return a
        b = read(parsed.right_path, scope) if parsed.right_path is not None else parsed.right_value
        if parsed.op == "==":
            return _same(a, b)
        if parsed.op == "!=":
            return not _same(a, b)
        if not _is_number(a) or not _is_number(b):
            raise fail("workflow_if", f'"{text}" compares things that are not numbers.')
        return {">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b}[parsed.op]

    def failure(err: BaseException) -> dict[str, str]:
        known = err if isinstance(err, BlokError) else BlokError("unexpected", str(err), id)
        return {"code": known.code, "message": known.message, "node": known.node}

    # What has to be taken back if a later step fails: the undo steps of each step that finished, oldest first.
    Undos = list[tuple[list[Any], Scope]]

    async def run(entries: list[Any], scope: Scope, call: Call, undos: Undos) -> None:
        for entry in entries:
            if "conditions" in entry:
                for branch in entry["conditions"]:
                    if "else" in branch or holds(branch["if"], scope):
                        await run(branch["else"] if "else" in branch else branch["steps"], scope, call, undos)
                        break
            elif "parallel" in entry:
                # Every branch is left to finish, also when one fails. A step still running would otherwise
                # finish after the undo steps had run, and never be taken back.
                branches = [run([one], scope, call, undos) for one in entry["parallel"]]
                for end in await asyncio.gather(*branches, return_exceptions=True):
                    if isinstance(end, BaseException):
                        raise end
                scope["prev"] = _NOTHING  # Several steps finished at once, so "the previous one" means nothing here.
            elif "fail" in entry:
                if entry.get("if") is not None and not holds(entry["if"], scope):
                    continue
                message = entry.get("message")
                told = f"Refused: {entry['fail']}." if message is None else _text(render(message, scope))
                raise fail(entry["fail"], told)
            else:
                if entry.get("if") and not holds(entry["if"], scope):
                    continue
                name, node = entry["name"], entry["node"]
                unit = units.get(node)
                if unit is None:
                    raise fail("workflow_node", f'Step "{name}" uses "{node}", which is not loaded.')
                nested = bool(is_workflow and is_workflow(node))

                def once(inside: Scope, unit: Unit = unit, entry: Any = entry, nested: bool = nested) -> Awaitable[Any]:
                    inputs = render(entry.get("inputs") or {}, inside)
                    # A workflow called as a step receives its inputs as the request body.
                    return call(unit, {"body": inputs} if nested else inputs, key=entry["name"])

                try:
                    if entry.get("each"):
                        items = render(entry["each"], scope)
                        if not isinstance(items, list):
                            raise fail("workflow_each", f'"{entry["each"]}" is not a list.')
                        scope[name] = await _map_limit(
                            items,
                            entry.get("concurrency") or 1,
                            lambda item, scope=scope, once=once: once(scope.new_child({"item": item})),
                        )
                    else:
                        scope[name] = await once(scope)
                except Exception as err:
                    if not entry.get("onError"):
                        raise
                    await run(entry["onError"], scope.new_child({"error": failure(err)}), call, undos)
                    raise
                if entry.get("undo"):
                    undos.append((entry["undo"], scope))
                scope["prev"] = scope[name]

    async def start(given: Any, ctx: WorkflowCtx) -> Any:
        asked = _request_of(given, request)
        # A request that lacks something a step is certain to need would fail at that step anyway.
        # Refusing it here means no earlier step has run and nothing has to be undone.
        absent = [target for target in needed if _dig(asked, target) is MISSING]
        if absent:
            raise fail("invalid_input", f"The request is missing: {', '.join('.'.join(target) for target in absent)}.")
        scope: Scope = ChainMap({"request": asked, "env": surroundings, "prev": _NOTHING})
        undos: Undos = []
        try:
            await run(list(workflow.get("steps") or []), scope, ctx.call, undos)
        except Exception as err:
            # Compensation: every step that finished and can be taken back is taken back, the newest first.
            # One undo that fails does not stop the others, and the caller still gets the error that caused it.
            said = failure(err)
            for steps, there in reversed(undos):
                try:
                    await run(steps, there.new_child({"error": said}), ctx.call, [])
                except Exception as undo_err:
                    ctx.log.error(f'{id}: a step could not be undone after "{said["code"]}".', undo_err)
            raise
        if "result" in workflow:
            answer = render(workflow["result"], scope)
            return None if answer is MISSING else answer
        return None if scope["prev"] is _NOTHING else scope["prev"]

    return define_unit(
        Unit(id=id, kind="workflow", input=None, output=None, run=start, description=workflow.get("description"))
    )


# ---- what starts a workflow -------------------------------------------------------------


@dataclass(frozen=True)
class Signature:
    """How a sender proves a request is theirs: an HMAC-SHA256 of the body, made with a secret both sides hold."""

    #: "standard" is Standard Webhooks. "stripe" and "github" are theirs. "hmac" is a bare signature in a header you name.
    scheme: str
    #: The secret itself. A workflow names the environment variable, and loading the project reads it.
    secret: str
    header: str | None = None
    encoding: str | None = None
    prefix: str | None = None


@dataclass(frozen=True)
class HttpBinding:
    method: str
    path: str
    unit: Unit
    #: The status of a successful answer. 200 when left out.
    success: int | None = None
    #: Error code to HTTP status. Transport details stay out of the node.
    status: Mapping[str, int] | None = None
    signature: Signature | None = None
    kind: str = "http"


@dataclass(frozen=True)
class CronBinding:
    schedule: str
    timezone: str
    #: What the workflow reads as its request body on every run.
    body: Any
    unit: Unit
    kind: str = "cron"


@dataclass(frozen=True)
class QueueBinding:
    queue: str
    unit: Unit
    concurrency: int | None = None
    kind: str = "queue"


@dataclass(frozen=True)
class ToolBinding:
    tool: str
    description: str
    #: JSON Schema of the arguments: the request body the workflow reads.
    input: dict[str, Any]
    unit: Unit
    #: JSON Schema of the answer, when it is known to be an object.
    output: dict[str, Any] | None = None
    kind: str = "mcp"


Binding = HttpBinding | CronBinding | QueueBinding | ToolBinding


def http_binding(workflow: Mapping[str, Any], unit: Unit, env: Mapping[str, Any] | None = None) -> HttpBinding | None:
    """The HTTP route of a workflow. `env` holds the secret a signed trigger names."""
    http = (workflow.get("trigger") or {}).get("http")
    if not http:
        return None
    signature = None
    if http.get("signature"):
        named = http["signature"]
        secret = (env or {}).get(named["secret"])
        if not secret:
            # A webhook that cannot check its signature must not start: it would either refuse everything or accept anything.
            raise RuntimeError(
                f"{unit.id} checks a signature with the secret in {named['secret']}, and no such value was given. "
                "Pass it in `env`, for example `env=os.environ`."
            )
        signature = Signature(
            scheme=named["scheme"],
            secret=secret,
            header=named.get("header"),
            encoding=named.get("encoding"),
            prefix=named.get("prefix"),
        )
    return HttpBinding(
        method=http["method"],
        path=http["path"],
        unit=unit,
        success=http.get("status"),
        status=http.get("errors"),
        signature=signature,
    )


def tool_name(id: str, workflow: Mapping[str, Any]) -> str:
    """The name an agent calls the workflow by: the one its trigger gives, or its file name with underscores."""
    given = ((workflow.get("trigger") or {}).get("mcp") or {}).get("tool")
    return given or id[id.index("/") + 1 :].split("@")[0].replace("-", "_")


def bindings_of(
    id: str,
    workflow: Mapping[str, Any],
    unit: Unit,
    shape: Mapping[str, Any] | None,
    env: Mapping[str, Any] | None = None,
) -> list[Binding]:
    """Everything outside that starts this workflow, as data for the adapters."""
    trigger = workflow.get("trigger") or {}
    out: list[Binding] = []
    http = http_binding(workflow, unit, env)
    if http:
        out.append(http)
    cron = trigger.get("cron")
    if cron:
        out.append(
            CronBinding(
                schedule=cron["schedule"], timezone=cron.get("timezone") or "UTC", body=cron.get("body", {}), unit=unit
            )
        )
    queue = trigger.get("queue")
    if queue:
        out.append(QueueBinding(queue=queue["name"], concurrency=queue.get("concurrency"), unit=unit))
    mcp = trigger.get("mcp")
    if mcp is not None:
        answers = (shape or {}).get("output")
        out.append(
            ToolBinding(
                tool=tool_name(id, workflow),
                description=mcp.get("description") or workflow.get("description") or workflow["name"],
                input={"type": "object", **((shape or {}).get("input") or {})},
                # A tool may only promise the shape of an answer that is an object.
                output=answers if isinstance(answers, dict) and answers.get("type") == "object" else None,
                unit=unit,
            )
        )
    return out
