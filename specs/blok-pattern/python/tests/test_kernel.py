"""What is Python's own: how a contract is written down, and how Python's two kinds of number become JSON's one."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

import pytest
from pydantic import BaseModel, Field

from blok import BlokError, Ctx, contract, fingerprint, is_todo, node, todo
from blok.kernel import number_text, whole
from blok.testing import call


class Line(BaseModel):
    sku: str
    qty: int = Field(gt=0, description="How many.")


class Order(BaseModel):
    lines: list[Line]
    note: str | None = None
    kind: Literal["web", "shop"] = "web"
    title: str = "untitled"


class Receipt(BaseModel):
    lines: list[Line]
    total: float
    paid: bool = False
    at: datetime | None = None


def price(input: Order, ctx: Ctx[None]) -> Receipt:
    return Receipt(lines=input.lines, total=sum(line.qty for line in input.lines) / 2)


receipt = node(
    id="shop/receipt@1",
    description="Totals an order.",
    input=Order,
    output=Receipt,
    errors={"empty": "The order has no lines."},
    effects=["clock"],
    run=price,
)


def test_a_contract_is_one_self_contained_json_schema():
    described = contract(receipt)
    line = {
        "type": "object",
        "properties": {
            "sku": {"type": "string"},
            "qty": {"type": "integer", "exclusiveMinimum": 0, "description": "How many."},
        },
        "required": ["sku", "qty"],
    }
    # What a caller may pass: a field with a default is optional, and a field named "title" is still a field.
    assert described["input"] == {
        "type": "object",
        "properties": {
            "lines": {"type": "array", "items": line},
            "note": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
            "kind": {"type": "string", "enum": ["web", "shop"], "default": "web"},
            "title": {"type": "string", "default": "untitled"},
        },
        "required": ["lines"],
    }
    # What comes back: every field is there, and there are no others.
    assert described["output"] == {
        "type": "object",
        "properties": {
            "lines": {"type": "array", "items": {**line, "additionalProperties": False}},
            "total": {"type": "number"},
            "paid": {"type": "boolean", "default": False},
            "at": {"anyOf": [{"type": "string", "format": "date-time"}, {"type": "null"}], "default": None},
        },
        "required": ["lines", "total", "paid", "at"],
        "additionalProperties": False,
    }
    assert {key: described[key] for key in ["id", "kind", "description", "errors", "errorMeanings", "effects"]} == {
        "id": "shop/receipt@1",
        "kind": "node",
        "description": "Totals an order.",
        "errors": ["empty"],
        "errorMeanings": {"empty": "The order has no lines."},
        "effects": ["clock"],
    }
    assert (described["idempotent"], described["implemented"]) == (False, True)


def test_a_model_that_contains_itself_cannot_be_a_contract():
    class Tree(BaseModel):
        children: list[Tree] = []

    Tree.model_rebuild()
    bad = node(id="shop/tree@1", input=Tree, output=Tree, run=todo)
    with pytest.raises(
        TypeError, match='shop/tree@1: its input schema cannot be written as JSON Schema. "Tree" contains itself'
    ):
        contract(bad)


def test_the_fingerprint_follows_what_other_things_rely_on_and_nothing_else():
    def again(**changes):
        given = {"id": "shop/receipt@1", "input": Order, "output": Receipt, "errors": {"empty": "x"}, "run": price}
        return fingerprint(node(**{**given, **changes}))

    same = again()
    assert same == again(description="Another description.", errors={"empty": "Said another way."}, run=todo)
    assert same != again(output=Order)
    assert same != again(errors={"empty": "x", "closed": "y"})
    assert len(same) == 64


def test_a_bad_id_is_refused_when_the_node_is_defined():
    with pytest.raises(TypeError, match='Bad unit id "Receipt". Expected "<module>/<node>@<version>".'):
        node(id="Receipt", input=Order, output=Receipt, run=todo)
    assert is_todo(node(id="shop/later@1", input=Order, output=Receipt, run=todo))


def test_a_whole_number_is_a_whole_number_however_python_holds_it():
    class Count(BaseModel):
        n: int
        ratio: float = 0

    echo = node(id="shop/count@1", input=Count, output=Count, run=lambda input, ctx: input)
    # 3.0 is 3 in JSON, so it is an integer here too. 3.5 is not.
    assert call(echo, {"n": 3.0, "ratio": 2}) == {"n": 3, "ratio": 2}
    with pytest.raises(BlokError) as refused:
        call(echo, {"n": 3.5})
    assert (refused.value.code, refused.value.message) == ("invalid_input", "n: Input should be a valid integer")
    # Text is not a number, and true is not 1.
    for wrong in ["3", True]:
        with pytest.raises(BlokError) as refused:
            call(echo, {"n": wrong})
        assert refused.value.code == "invalid_input"
    assert whole({"a": [1.0, 2.5, {"b": 1e300}], "c": True}) == {"a": [1, 2.5, {"b": 1e300}], "c": True}
    assert type(whole(2.0)) is int and type(whole(1e300)) is float


def test_a_number_is_written_as_text_the_way_json_writes_it():
    # A list of pairs: as keys of a dict, 2 and 2.0 would be one entry.
    said = [(2, "2"), (2.0, "2"), (-0.25, "-0.25"), (0.1 + 0.2, "0.30000000000000004"), (1e21, "1e+21")]
    said += [(1.5e22, "1.5e+22"), (1e-6, "0.000001"), (1e-7, "1e-7"), (1.25e-9, "1.25e-9"), (123456.789, "123456.789")]
    said += [(1.2345678901234568e20, "123456789012345680000"), (0.0, "0"), (-0.0, "0"), (5e-324, "5e-324")]
    said += [(1.7976931348623157e308, "1.7976931348623157e+308"), (100.0, "100"), (-1e21, "-1e+21")]
    assert [(value, number_text(value)) for value, _ in said] == said


def test_a_node_may_be_async_or_plain_and_answer_with_a_model_or_a_dict():
    class N(BaseModel):
        n: int

    async def twice(input: N, ctx: Ctx[dict]) -> N:
        return N(n=input.n * ctx.ports["by"])

    plain = node(id="shop/plain@1", input=N, output=N, run=lambda input, ctx: {"n": input.n + 1})
    waited = node(id="shop/waited@1", input=N, output=N, run=twice)
    assert call(plain, {"n": 1}) == {"n": 2}
    assert call(waited, N(n=4), ports={"by": 3}) == {"n": 12}
