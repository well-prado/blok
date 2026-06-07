"""Tests for the typed `@node` contract (SPEC-B P2)."""

import json

import pytest
from pydantic import BaseModel, Field

from blok import Context, node
from blok.errors.blok_error import BlokError
from blok.node.define_node import (
    _reset_decorated_for_tests,
    register_decorated,
    registered_nodes,
)
from blok.node.node_registry import NodeRegistry
from blok.server.grpc_server import _node_schema_bytes


class _Input(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(10, ge=1, le=100)


class _Output(BaseModel):
    results: list[str]
    count: int


@pytest.fixture(autouse=True)
def _isolate():
    _reset_decorated_for_tests()
    yield
    _reset_decorated_for_tests()


def _ctx() -> Context:
    return Context(id="t", workflow_name="wf", workflow_path="/wf")


def test_validates_input_and_serializes_output():
    @node(name="@acme/search", description="Full-text search")
    def search(ctx: Context, inp: _Input) -> _Output:
        assert isinstance(inp, _Input)  # validated, typed — not a raw dict
        return _Output(results=[inp.query] * inp.limit, count=inp.limit)

    out = search.execute(_ctx(), {"query": "ada", "limit": 2})
    assert out == {"results": ["ada", "ada"], "count": 2}  # serialized dict


def test_applies_pydantic_defaults():
    @node(name="@acme/d")
    def d(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=inp.limit)

    out = d.execute(_ctx(), {"query": "x"})  # limit omitted → default 10
    assert out["count"] == 10


def test_invalid_input_raises_structured_blok_error():
    @node(name="@acme/search2")
    def search(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=0)

    with pytest.raises(BlokError) as ei:
        search.execute(_ctx(), {"limit": 999})  # missing query + limit out of range
    err = ei.value
    assert err.code == "NODE_INPUT_VALIDATION"
    assert err.http_status == 400
    assert "query" in str(err.message)


def test_invalid_output_raises():
    @node(name="@acme/bado")
    def bad(ctx: Context, inp: _Input) -> _Output:
        return {"results": "not-a-list", "count": "nope"}  # wrong shape

    with pytest.raises(BlokError) as ei:
        bad.execute(_ctx(), {"query": "x"})
    assert ei.value.code == "NODE_OUTPUT_VALIDATION"


def test_untyped_node_passes_dict_through():
    @node(name="@acme/raw")  # no model annotations
    def raw(ctx, config):
        return {"echo": config.get("a")}

    assert raw.execute(_ctx(), {"a": 1}) == {"echo": 1}


def test_reflection_schemas():
    @node(name="@acme/r")
    def r(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=0)

    inp_schema = r.input_json_schema()
    assert inp_schema["type"] == "object"
    assert "query" in inp_schema["properties"]
    out_schema = r.output_json_schema()
    assert out_schema["properties"]["count"]["type"] == "integer"


def test_auto_registration():
    @node(name="@acme/a")
    def a(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=0)

    @node(name="@acme/b", register=False)  # opt out
    def b(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=0)

    names = [h.name for h in registered_nodes()]
    assert "@acme/a" in names
    assert "@acme/b" not in names

    registry = NodeRegistry()
    count = register_decorated(registry)
    assert count == 1
    assert registry.get("@acme/a") is not None


def test_listnodes_schema_bytes_for_typed_and_legacy():
    @node(name="@acme/typed")
    def typed(ctx: Context, inp: _Input) -> _Output:
        return _Output(results=[], count=0)

    # Typed node → real JSON Schema bytes.
    raw = _node_schema_bytes(typed, "input_json_schema")
    assert raw != b""
    assert json.loads(raw)["type"] == "object"

    # A legacy handler without the reflection method → empty bytes.
    class Legacy:
        description = "legacy"

    assert _node_schema_bytes(Legacy(), "input_json_schema") == b""
