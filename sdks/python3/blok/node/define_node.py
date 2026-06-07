"""Typed, declarative node authoring for the Python SDK (SPEC-B P2).

The `@node` decorator is the Python equivalent of the TypeScript `defineNode`:
declare typed Pydantic `Input`/`Output` models, get automatic validation +
JSON-Schema reflection, and auto-registration — instead of a raw
`Dict[str, Any]` handler with manual `.get()` parsing.

Example::

    from pydantic import BaseModel, Field
    from blok import node, Context

    class Input(BaseModel):
        query: str = Field(min_length=1)
        limit: int = Field(10, ge=1, le=100)

    class Output(BaseModel):
        results: list[str]
        count: int

    @node(name="@acme/search", description="Full-text search")
    def search(ctx: Context, input: Input) -> Output:
        rows = do_search(input.query, input.limit)   # input is a validated Input
        return Output(results=rows, count=len(rows))

The SDK validates `config -> Input` BEFORE `search` runs (a Pydantic
`ValidationError` becomes a structured `BlokError` with HTTP 400 + field paths),
validates the return against `Output`, and serializes it to a JSON dict. Omit
the model annotations and `@node` behaves like a legacy raw-dict handler, so
migration is incremental and the existing `NodeHandler` ABC keeps working.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Dict, List, Optional, Tuple, Type, get_type_hints

from pydantic import BaseModel, ValidationError

from ..errors.blok_error import BlokError
from ..types.context import Context
from .node_handler import NodeHandler

# Module-global collection of `@node`-decorated handlers. Importing the module
# that declares them runs the decorator (side effect) and appends here;
# `register_decorated(registry)` then flushes them into a registry, so authors
# never edit a central `register_all`.
_DECORATED_NODES: List[NodeHandler] = []


def _format_validation_error(node_name: str, err: ValidationError) -> str:
    parts: List[str] = []
    for e in err.errors():
        loc = ".".join(str(x) for x in e.get("loc", ())) or "(root)"
        parts.append(f"{loc} ({e.get('msg', 'invalid')})")
    return f"Validation failed for node '{node_name}': " + "; ".join(parts)


class FunctionNode(NodeHandler):
    """A `NodeHandler` produced by `@node`. Validates I/O against Pydantic models."""

    def __init__(
        self,
        *,
        name: str,
        description: str,
        func: Callable[[Context, Any], Any],
        input_model: Optional[Type[BaseModel]],
        output_model: Optional[Type[BaseModel]],
    ) -> None:
        self.name = name
        self.description = description
        self._func = func
        self.input_model = input_model
        self.output_model = output_model

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        # 1. Validate input → typed model (or pass the raw dict through untyped).
        validated_input: Any = config
        if self.input_model is not None:
            try:
                validated_input = self.input_model.model_validate(config)
            except ValidationError as err:
                raise BlokError.validation(
                    code="NODE_INPUT_VALIDATION",
                    message=_format_validation_error(self.name, err),
                    details=err.errors(),
                    http_status=400,
                    node=self.name,
                ) from err

        # 2. Run the user's function.
        result = self._func(ctx, validated_input)

        # 3. Validate + serialize output (when declared).
        if self.output_model is not None:
            model = result if isinstance(result, self.output_model) else None
            if model is None:
                try:
                    model = self.output_model.model_validate(result)
                except ValidationError as err:
                    raise BlokError.validation(
                        code="NODE_OUTPUT_VALIDATION",
                        message=f"Output validation failed for node '{self.name}': "
                        + "; ".join(
                            f"{'.'.join(str(x) for x in e.get('loc', ()))} ({e.get('msg', 'invalid')})"
                            for e in err.errors()
                        ),
                        details=err.errors(),
                        http_status=500,
                        node=self.name,
                    ) from err
            return model.model_dump(mode="json")

        # Untyped: a Pydantic model still serializes; otherwise pass through.
        if isinstance(result, BaseModel):
            return result.model_dump(mode="json")
        return result

    def input_json_schema(self) -> Optional[Dict[str, Any]]:
        return self.input_model.model_json_schema() if self.input_model is not None else None

    def output_json_schema(self) -> Optional[Dict[str, Any]]:
        return self.output_model.model_json_schema() if self.output_model is not None else None


def _resolve_models(
    func: Callable[..., Any],
) -> Tuple[Optional[Type[BaseModel]], Optional[Type[BaseModel]]]:
    """Infer the input/output Pydantic models from a node function's signature.

    Convention: `def execute(ctx, input: Input) -> Output`. The input model is
    the annotation of the SECOND positional parameter; the output model is the
    return annotation. Non-`BaseModel` (or missing) annotations → `None`
    (untyped — the node receives the raw dict).
    """
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    sig = inspect.signature(func)
    params = list(sig.parameters.values())

    input_model: Optional[Type[BaseModel]] = None
    if len(params) >= 2:
        second = params[1]
        ann = hints.get(second.name, second.annotation)
        if isinstance(ann, type) and issubclass(ann, BaseModel):
            input_model = ann

    ret = hints.get("return", sig.return_annotation)
    output_model = ret if isinstance(ret, type) and issubclass(ret, BaseModel) else None

    return input_model, output_model


def node(
    name: str,
    description: str = "",
    *,
    register: bool = True,
) -> Callable[[Callable[[Context, Any], Any]], FunctionNode]:
    """Decorate a node function into a validated, auto-registered `FunctionNode`.

    :param name: the node's registered name (e.g. `"@acme/search"`).
    :param description: human-readable description (surfaced in `/__blok/nodes`).
    :param register: append to the module-global collection for
        `register_decorated()`. Set `False` for ad-hoc / test nodes.
    """

    def decorator(func: Callable[[Context, Any], Any]) -> FunctionNode:
        input_model, output_model = _resolve_models(func)
        handler = FunctionNode(
            name=name,
            description=description,
            func=func,
            input_model=input_model,
            output_model=output_model,
        )
        if register:
            _DECORATED_NODES.append(handler)
        return handler

    return decorator


def registered_nodes() -> List[NodeHandler]:
    """All `@node`-decorated handlers collected so far (import-order)."""
    return list(_DECORATED_NODES)


def register_decorated(registry: Any) -> int:
    """Register every collected `@node` handler into `registry`. Returns the count."""
    count = 0
    for handler in _DECORATED_NODES:
        registry.register(getattr(handler, "name"), handler)
        count += 1
    return count


def _reset_decorated_for_tests() -> None:
    """Clear the global collection (test isolation)."""
    _DECORATED_NODES.clear()
