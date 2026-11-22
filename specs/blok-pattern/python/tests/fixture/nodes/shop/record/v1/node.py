from ports import Ports
from pydantic import BaseModel

from blok import Ctx, node


class Input(BaseModel):
    note: str


class Output(BaseModel):
    note: str
    position: int


async def run(input: Input, ctx: Ctx[Ports]) -> Output:
    if input.note == "break":
        raise RuntimeError("the journal is full")
    ctx.ports.journal.append(input.note)
    return Output(note=input.note, position=len(ctx.ports.journal))


record = node(
    id="shop/record@1",
    description='Writes a note in the journal. The note "break" breaks it.',
    input=Input,
    output=Output,
    effects=["journal"],
    run=run,
)
