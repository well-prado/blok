import pytest
from ports import memory_ports

from blok import BlokError
from blok.testing import call, node_beside

price = node_beside(__file__)


def test_it_multiplies():
    assert call(price, {"sku": "book", "qty": 3}, ports=memory_ports()) == {"total_cents": 7500}


def test_it_refuses_a_product_it_does_not_know():
    with pytest.raises(BlokError) as refused:
        call(price, {"sku": "sofa", "qty": 1}, ports=memory_ports())
    assert refused.value.code == "unknown_sku"
