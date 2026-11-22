"""For a node's own test, which sits beside it:

from blok.testing import call, node_beside

greet = node_beside(__file__)

def test_it_greets():
    assert call(greet, {"name": "Ada"}, ports=memory_ports()) == {"message": "Hello, Ada!"}
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .kernel import Log, Runtime, Span, Unit
from .project import NodeFileError, _only_node


def node_beside(test_file: str) -> Unit:
    """The node in the `node.py` beside this test file: `greet = node_beside(__file__)`."""
    file = Path(test_file).resolve().parent / "node.py"
    unit = _only_node(file, str(file))
    path, _, version = unit.id.partition("@")
    expected = [*path.split("/"), f"v{version}"]
    if list(file.parent.parts[-len(expected) :]) != expected:
        raise NodeFileError(f'{file} declares "{unit.id}", but that node lives at {"/".join(expected)}/node.py.')
    return unit


def call(
    unit: Unit,
    input: Any = None,
    *,
    ports: Any = None,
    log: Log | None = None,
    on_span: Callable[[Span], None] | None = None,
) -> Any:
    """Calls a node and waits for its answer, through the same boundary the app uses. It raises `BlokError`."""
    return asyncio.run(Runtime(ports=ports, log=log, on_span=on_span).call(unit, input))
