"""The nodes the shared tests run on, in Python. conformance/README.md says what each one does,
and packages/kernel/test/conformance/nodes.ts is the same list in TypeScript."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from blok import Ctx, node, todo


@dataclass
class Ports:
    #: What the nodes wrote down, in the order they wrote it.
    journal: list[str] = field(default_factory=list)
    #: How many times each name was counted.
    counter: dict[str, int] = field(default_factory=dict)


class Nothing(BaseModel):
    pass


class AddIn(BaseModel):
    a: float
    b: float


class AddOut(BaseModel):
    sum: float


class GreetIn(BaseModel):
    name: str
    greeting: str = "Hello"


class Text(BaseModel):
    text: str


class Value(BaseModel):
    value: Any


class Typed(BaseModel):
    count: int
    ratio: float = 1
    flag: bool = False
    tags: list[str] = []


class Item(BaseModel):
    sku: str
    qty: int


class Items(BaseModel):
    items: list[Item]
    total: int


class FailIn(BaseModel):
    code: str
    message: str = "It failed."


class MaybeIn(BaseModel):
    ok: bool
    note: str = ""


class Note(BaseModel):
    note: str


class Recorded(BaseModel):
    note: str
    position: int


class FlakyIn(BaseModel):
    name: str
    failures: int
    refuse: bool = False


class Calls(BaseModel):
    calls: int


class SlowIn(BaseModel):
    ms: int


class Slept(BaseModel):
    slept: int


class Number(BaseModel):
    n: float


class Named(BaseModel):
    name: str


def fail(input: FailIn, ctx: Ctx[Ports]) -> Nothing:
    raise ctx.fail(input.code, input.message)


def maybe(input: MaybeIn, ctx: Ctx[Ports]) -> Note:
    ctx.ports.journal.append(input.note)
    if not input.ok:
        raise ctx.fail("refused", f"It was refused: {input.note}")
    return Note(note=input.note)


def record(input: Note, ctx: Ctx[Ports]) -> Recorded:
    ctx.ports.journal.append(input.note)
    return Recorded(note=input.note, position=len(ctx.ports.journal))


def flaky(input: FlakyIn, ctx: Ctx[Ports]) -> Calls:
    """Counts a call, fails while the count is no more than `failures`, and can refuse instead."""
    calls = ctx.ports.counter.get(input.name, 0) + 1
    ctx.ports.counter[input.name] = calls
    if input.refuse:
        raise ctx.fail("refused", "It was refused.")
    if calls <= input.failures:
        raise RuntimeError(f"flaky failure {calls}")
    return Calls(calls=calls)


async def slow(input: SlowIn, ctx: Ctx[Ports]) -> Slept:
    await asyncio.sleep(input.ms / 1000)
    return Slept(slept=input.ms)


def crash(input: Nothing, ctx: Ctx[Ports]) -> Nothing:
    raise RuntimeError("the database is down")


nodes = [
    node(
        id="test/add@1",
        description="Adds two numbers.",
        input=AddIn,
        output=AddOut,
        run=lambda input, ctx: {"sum": input.a + input.b},
    ),
    node(
        id="test/greet@1",
        description="Greets someone by name.",
        input=GreetIn,
        output=Text,
        run=lambda input, ctx: Text(text=f"{input.greeting}, {input.name}!"),
    ),
    node(
        id="test/echo@1",
        description="Answers with the value it was given, whatever it is.",
        input=Value,
        output=Value,
        run=lambda input, ctx: input,
    ),
    node(
        id="test/typed@1",
        description="Answers with what it was given: a whole number, a number, true or false, and a list of text.",
        input=Typed,
        output=Typed,
        run=lambda input, ctx: input,
    ),
    node(
        id="test/items@1",
        description="Answers with a fixed list of two items.",
        input=Nothing,
        output=Items,
        run=lambda input, ctx: {"items": [{"sku": "book", "qty": 2}, {"sku": "pen", "qty": 5}], "total": 7},
    ),
    node(
        id="test/fail@1",
        description="Always fails, with the code and the message it was given.",
        input=FailIn,
        output=Nothing,
        errors={"out_of_stock": "Nothing is left to sell.", "card_declined": "The bank refused the card."},
        run=fail,
    ),
    node(
        id="test/maybe@1",
        description="Writes its note down, then refuses unless `ok` is true.",
        input=MaybeIn,
        output=Note,
        errors={"refused": "`ok` was false."},
        effects=["journal:write"],
        run=maybe,
    ),
    node(
        id="test/record@1",
        description="Writes its note down and says where in the journal it landed, counting from 1.",
        input=Note,
        output=Recorded,
        effects=["journal:write"],
        run=record,
    ),
    node(
        id="test/flaky@1",
        description="Fails the first `failures` times it is called under a name. Safe to run twice, and tried up to 3 times.",
        input=FlakyIn,
        output=Calls,
        errors={"refused": "`refuse` was true."},
        effects=["counter:write"],
        idempotent=True,
        retries=2,
        run=flaky,
    ),
    node(
        id="test/once@1",
        description="The same as test/flaky, and not safe to run twice, so it is never tried again.",
        input=FlakyIn,
        output=Calls,
        errors={"refused": "`refuse` was true."},
        effects=["counter:write"],
        retries=2,
        run=flaky,
    ),
    node(
        id="test/slow@1",
        description="Waits `ms` milliseconds. It is given 40, and is tried twice.",
        input=SlowIn,
        output=Slept,
        idempotent=True,
        retries=1,
        timeout_ms=40,
        run=slow,
    ),
    node(
        id="test/wrong@1",
        description="Promises a number and answers with text.",
        input=Nothing,
        output=Number,
        run=lambda input, ctx: {"n": "not a number"},
    ),
    node(
        id="test/crash@1",
        description="Breaks in a way nobody planned for.",
        input=Nothing,
        output=Nothing,
        run=crash,
    ),
    node(
        id="test/empty@1",
        description="A contract with no logic yet.",
        input=Named,
        output=Text,
        run=todo,
    ),
]
