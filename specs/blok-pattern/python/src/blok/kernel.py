"""The whole runtime of the pattern, in Python.

It follows PATTERN.md, and the shared tests in conformance/cases decide whether it does.
Contracts are Pydantic models. Nothing else is needed to call a node.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import re
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Generic, Literal, Protocol, TypeVar

from pydantic import TypeAdapter, ValidationError
from pydantic.json_schema import GenerateJsonSchema
from pydantic_core import to_json, to_jsonable_python

VERSION = "3.0.0a0"


class BlokError(Exception):
    """A failure with a code a caller can branch on, and the node it came from."""

    def __init__(self, code: str, message: str, node: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.node = node
        self.details = details


class Log(Protocol):
    def info(self, message: str, data: Any = None) -> None: ...
    def error(self, message: str, data: Any = None) -> None: ...


class _Silent:
    def info(self, message: str, data: Any = None) -> None:
        pass

    def error(self, message: str, data: Any = None) -> None:
        pass


class _Console(_Silent):
    def error(self, message: str, data: Any = None) -> None:
        print(message if data is None else f"{message} {data!r}", file=sys.stderr)


#: Says nothing unless something failed, and then says it on stderr. What an adapter uses when it is given no log.
console_log: Log = _Console()

P = TypeVar("P")


@dataclass(frozen=True)
class Ctx(Generic[P]):
    """What a node is handed besides its input. It reaches the outside world through ports and cannot call other units."""

    ports: P
    log: Log
    #: `raise ctx.fail("card_declined", "The bank refused the card.")`. It refuses a code the contract does not declare.
    fail: Callable[..., BlokError]


@dataclass(frozen=True)
class WorkflowCtx:
    """A workflow only wires. It can call units and has no ports of its own. The workflow runner is its only author."""

    call: Callable[..., Awaitable[Any]]
    log: Log
    fail: Callable[..., BlokError]


@dataclass(frozen=True)
class Unit:
    """A node or a workflow: something with an id and a contract that the kernel can call."""

    id: str
    kind: Literal["node", "workflow"]
    #: A Pydantic model, or any type Pydantic can check. `None` takes anything, which is what a workflow does.
    input: Any
    output: Any
    run: Callable[..., Any]
    description: str | None = None
    #: Business failures callers may branch on, each with when it happens. A plain list of codes also works.
    errors: Mapping[str, str] | Sequence[str] = ()
    #: Ports this unit touches, such as "payments:charge". Empty means pure.
    effects: Sequence[str] = ()
    #: Safe to run twice with the same input. Retries only apply when true.
    idempotent: bool = False
    retries: int = 0
    timeout_ms: int | None = None


@dataclass(frozen=True)
class Span:
    id: str
    kind: str
    ms: float
    attempts: int
    ok: bool
    parent: str | None = None
    key: str | None = None
    error: str | None = None


_ID = re.compile(r"[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)+@[1-9][0-9]*")


def define_unit(unit: Unit) -> Unit:
    """Checks the id. `node()` calls it, and so does the workflow runner."""
    if not _ID.fullmatch(unit.id):
        raise TypeError(f'Bad unit id "{unit.id}". Expected "<module>/<node>@<version>".')
    return unit


def todo(*_args: Any, **_kwargs: Any) -> Any:
    """The body of a node whose contract is written and whose logic is not: `run=todo`.

    Workflows can already be wired and checked against it. Calling it fails with "not_implemented".
    """
    raise NotImplementedError("This node is not implemented yet.")


def is_todo(unit: Unit) -> bool:
    return unit.run is todo


def node(
    *,
    id: str,
    input: Any,
    output: Any,
    run: Callable[..., Any],
    description: str | None = None,
    errors: Mapping[str, str] | Sequence[str] = (),
    effects: Sequence[str] = (),
    idempotent: bool = False,
    retries: int = 0,
    timeout_ms: int | None = None,
) -> Unit:
    """A node: a contract and the function that keeps it. The folder the file lives in is its id."""
    return define_unit(
        Unit(
            id=id,
            kind="node",
            input=input,
            output=output,
            run=run,
            description=description,
            errors=errors,
            effects=tuple(effects),
            idempotent=idempotent,
            retries=retries,
            timeout_ms=timeout_ms,
        )
    )


def error_codes(unit: Unit) -> list[str]:
    """The error codes a unit declares, whichever way it wrote them."""
    return list(unit.errors.keys()) if isinstance(unit.errors, Mapping) else list(unit.errors)


def may_work_later(code: str) -> bool:
    """Whether a failure is the code's or the machine's, so that running the same thing again may work.

    Every other code is a refusal: a business error or a wrong input, which will be refused again.
    """
    return re.fullmatch(r"unexpected|timeout|not_implemented|invalid_output|workflow_[a-z]+", code) is not None


# ---- numbers ----------------------------------------------------------------------------
# JSON has one kind of number, so 2 and 2.0 are the same value. Python has two, and would print "2.0".


def whole(value: Any) -> Any:
    """A copy in which every number that is whole is an `int`, so 2.0 is 2 wherever it goes next."""
    if isinstance(value, float):
        return int(value) if value.is_integer() and abs(value) <= 2**53 else value
    if isinstance(value, dict):
        return {key: whole(inner) for key, inner in value.items()}
    if isinstance(value, (list, tuple)):
        return [whole(inner) for inner in value]
    return value


def number_text(value: int | float) -> str:
    """A number as text, written the way JSON writes it everywhere else: 2, 1.5, 1e-7, 1e+21."""
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        return "null"
    sign, digit_tuple, exponent = Decimal(repr(value)).as_tuple()
    digits = "".join(map(str, digit_tuple)).lstrip("0") or "0"
    stripped = digits.rstrip("0") or "0"
    exponent = int(exponent) + len(digits) - len(stripped)
    digits = stripped
    if digits == "0":
        return "0"
    count, point = len(digits), len(digits) + exponent
    if count <= point <= 21:
        text = digits + "0" * (point - count)
    elif 0 < point <= 21:
        text = f"{digits[:point]}.{digits[point:]}"
    elif -6 < point <= 0:
        text = "0." + "0" * -point + digits
    else:
        power = point - 1
        mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
        text = f"{mantissa}e{'+' if power > 0 else '-'}{abs(power)}"
    return f"-{text}" if sign else text


# ---- contracts --------------------------------------------------------------------------


class _Schema(GenerateJsonSchema):
    """What a node answers with always has every field, also the ones with a default."""

    def field_is_required(self, field: Any, total: bool) -> bool:
        if self.mode == "serialization" and field["type"] != "typed-dict-field":
            return not field.get("serialization_exclude")
        return super().field_is_required(field, total)


_adapters: dict[int, tuple[Any, TypeAdapter[Any]]] = {}


def _adapter(kind: Any) -> TypeAdapter[Any]:
    known = _adapters.get(id(kind))
    if known is None or known[0] is not kind:
        known = (kind, TypeAdapter(kind))
        _adapters[id(kind)] = known
    return known[1]


def _tidy(schema: Any, closed: bool) -> Any:
    """One self-contained JSON Schema: every `$ref` is replaced by what it points at, and the titles Pydantic adds are gone."""
    definitions = schema.get("$defs", {}) if isinstance(schema, dict) else {}

    def walk(part: Any, inside: frozenset[str]) -> Any:
        if isinstance(part, list):
            return [walk(inner, inside) for inner in part]
        if not isinstance(part, dict):
            return part
        if "$ref" in part:
            name = str(part["$ref"]).removeprefix("#/$defs/")
            if name in inside:
                raise TypeError(f'"{name}" contains itself, and a contract cannot go on forever')
            merged = {**definitions[name], **{key: inner for key, inner in part.items() if key != "$ref"}}
            return walk(merged, inside | {name})
        out: dict[str, Any] = {}
        for key, inner in part.items():
            if key == "$defs" or (key == "title" and isinstance(inner, str)):
                continue
            if key in ("properties", "patternProperties") and isinstance(inner, dict):
                out[key] = {name: walk(field, inside) for name, field in inner.items()}
            elif key in ("default", "const", "enum", "examples", "required"):
                out[key] = inner
            else:
                out[key] = walk(inner, inside)
        # A model answers with the fields it declares and no others.
        if closed and "properties" in out and "additionalProperties" not in out:
            out["additionalProperties"] = False
        return out

    return walk(schema, frozenset())


def json_schema_of(unit: Unit, io: Literal["input", "output"]) -> dict[str, Any]:
    """A unit's input or output as JSON Schema. "input" is what a caller may pass, "output" is what comes back."""
    kind = unit.input if io == "input" else unit.output
    if kind is None:
        return {}
    try:
        mode: Literal["validation", "serialization"] = "validation" if io == "input" else "serialization"
        return _tidy(_adapter(kind).json_schema(mode=mode, schema_generator=_Schema), closed=io == "output")
    except Exception as err:
        raise TypeError(f"{unit.id}: its {io} schema cannot be written as JSON Schema. {err}.") from err


def contract(unit: Unit) -> dict[str, Any]:
    """The language-neutral form of a unit: what a planner writes first and what other languages and agents read."""
    described: dict[str, Any] = {"id": unit.id, "kind": unit.kind}
    if unit.description is not None:
        described["description"] = unit.description
    described.update(
        input=json_schema_of(unit, "input"),
        output=json_schema_of(unit, "output"),
        errors=error_codes(unit),
        errorMeanings=dict(unit.errors) if isinstance(unit.errors, Mapping) else {},
        effects=list(unit.effects),
        idempotent=unit.idempotent,
        implemented=not is_todo(unit),
    )
    return described


def fingerprint(unit: Unit) -> str:
    """A short name for what other things rely on in a node: what it takes, what it answers with and how it may fail.

    `blokctl build` writes it down, and loading the app compares, so an app never runs on wiring that was
    checked against other contracts.
    """
    described = contract(unit)
    relied_on = {"input": described["input"], "output": described["output"], "errors": sorted(described["errors"])}
    text = json.dumps(relied_on, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


def _issues(err: ValidationError) -> str:
    said = []
    for issue in err.errors(include_url=False):
        where = ".".join(str(part) for part in issue["loc"])
        said.append(f"{where}: {issue['msg']}" if where else issue["msg"])
    return "; ".join(said)


def _parse_input(unit: Unit, raw: Any) -> Any:
    if unit.input is None:
        return raw
    try:
        # A contract is JSON Schema, so the input is checked as JSON: text is not a number, and 3.0 is a whole number.
        return _adapter(unit.input).validate_json(to_json(whole(to_jsonable_python(raw))), strict=True)
    except ValidationError as err:
        raise BlokError("invalid_input", _issues(err), unit.id, err.errors(include_url=False)) from None


def _parse_output(unit: Unit, out: Any) -> Any:
    if unit.output is None:
        return out
    adapter = _adapter(unit.output)
    try:
        return whole(adapter.dump_python(adapter.validate_python(out), mode="json", by_alias=True))
    except ValidationError as err:
        raise BlokError("invalid_output", _issues(err), unit.id, err.errors(include_url=False)) from None


# ---- calling ----------------------------------------------------------------------------


class Runtime:
    """Runs units. One per app, holding the ports the nodes reach the outside world through."""

    def __init__(self, *, ports: Any, log: Log | None = None, on_span: Callable[[Span], None] | None = None) -> None:
        self.ports = ports
        self.log: Log = log or _Silent()
        self.on_span = on_span

    async def call(self, unit: Unit, input: Any = None, *, key: str | None = None) -> Any:
        """Calls a node or a workflow and answers with its output as plain data: dicts, lists, text and numbers."""
        return await self._exec(unit, input, None, key)

    async def _exec(self, unit: Unit, raw: Any, parent: str | None, key: str | None) -> Any:
        start = time.perf_counter()
        attempts = 0

        def done(ok: bool, error: str | None = None) -> None:
            if self.on_span:
                ms = (time.perf_counter() - start) * 1000
                self.on_span(
                    Span(
                        id=unit.id, kind=unit.kind, parent=parent, key=key, ms=ms, attempts=attempts, ok=ok, error=error
                    )
                )

        try:
            data = _parse_input(unit, raw)
            # After the input check, so a node that is only designed already refuses what its contract refuses.
            if is_todo(unit):
                raise BlokError("not_implemented", f"{unit.id} is not implemented yet.", unit.id)
            declared = set(error_codes(unit))

            def fail(code: str, message: str, details: Any = None) -> BlokError:
                if code not in declared:
                    raise TypeError(f'{unit.id} failed with "{code}", which its contract does not declare.')
                return BlokError(code, message, unit.id, details)

            most = unit.retries if unit.idempotent else 0
            while True:
                attempts += 1
                try:
                    output = _parse_output(unit, await self._attempt(unit, data, fail))
                    done(True)
                    return output
                except BlokError as err:
                    # A business error is an answer. Only running out of time is worth another try.
                    if err.code != "timeout" or attempts > most:
                        raise
                except Exception:
                    if attempts > most:
                        raise
        except BlokError as err:
            done(False, err.code)
            raise
        except Exception as err:
            done(False, "unexpected")
            raise BlokError("unexpected", str(err), unit.id, err) from err

    async def _attempt(self, unit: Unit, data: Any, fail: Callable[..., BlokError]) -> Any:
        async def run() -> Any:
            if unit.kind == "workflow":

                def call(inner: Unit, input: Any = None, *, key: str | None = None) -> Awaitable[Any]:
                    return self._exec(inner, input, unit.id, key)

                return await unit.run(data, WorkflowCtx(call=call, log=self.log, fail=fail))
            ctx: Ctx[Any] = Ctx(ports=self.ports, log=self.log, fail=fail)
            if inspect.iscoroutinefunction(unit.run):
                return await unit.run(data, ctx)
            # A plain function may block, so it runs on a thread and the server keeps answering.
            out = await asyncio.to_thread(unit.run, data, ctx)
            return await out if inspect.isawaitable(out) else out

        if not unit.timeout_ms:
            return await run()
        try:
            return await asyncio.wait_for(run(), unit.timeout_ms / 1000)
        except TimeoutError:
            raise BlokError("timeout", f"{unit.id} was aborted", unit.id) from None


def runtime(*, ports: Any, log: Log | None = None, on_span: Callable[[Span], None] | None = None) -> Runtime:
    return Runtime(ports=ports, log=log, on_span=on_span)
