"""Typed greeting node demonstrating the SPEC-B @node contract."""

from __future__ import annotations

from pydantic import BaseModel

from blok import node
from blok.types.context import Context


class TypedGreetInput(BaseModel):
    name: str
    repeat: int = 1


class TypedGreetOutput(BaseModel):
    greeting: str
    length: int


@node("typed-greet", "Typed greeting (SPEC-B contract demo)")
def typed_greet(ctx: Context, input: TypedGreetInput) -> TypedGreetOutput:
    repeat = input.repeat if input.repeat > 0 else 1
    greeting = ("Hello, " + input.name) * repeat
    return TypedGreetOutput(greeting=greeting, length=len(greeting))
