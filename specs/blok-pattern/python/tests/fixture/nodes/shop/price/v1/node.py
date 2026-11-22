from ports import Ports
from pydantic import BaseModel, Field

from blok import Ctx, node

PRICES = {"book": 2500, "desk": 18000}


class Input(BaseModel):
    sku: str
    qty: int = Field(gt=0)


class Output(BaseModel):
    total_cents: int


def run(input: Input, ctx: Ctx[Ports]) -> Output:
    each = PRICES.get(input.sku)
    if each is None:
        raise ctx.fail("unknown_sku", f'There is no product "{input.sku}".')
    return Output(total_cents=each * input.qty)


price = node(
    id="shop/price@1",
    description="Prices a quantity of one product.",
    input=Input,
    output=Output,
    errors={"unknown_sku": "Nothing with that name is sold."},
    run=run,
)
