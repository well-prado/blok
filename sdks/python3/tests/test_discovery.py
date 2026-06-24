"""Tests for user-node discovery (`load_user_nodes`) — the Python on-ramp.

`blokctl create node` scaffolds an `@node` into `runtimes/python3/nodes/<name>/`;
the runtime discovers + registers it at boot via `BLOK_NODES_DIR`.
"""

import pytest

from blok import Context
from blok.node.define_node import _reset_decorated_for_tests, load_user_nodes
from blok.node.node_registry import NodeRegistry

_SCAFFOLD = """\
from pydantic import BaseModel

from blok import node
from blok.types.context import Context


class Input(BaseModel):
    name: str = "world"


class Output(BaseModel):
    message: str


@node("my-greeter", "demo")
def run(ctx: Context, input: Input) -> Output:
    return Output(message=f"Hello, {input.name}!")
"""


@pytest.fixture(autouse=True)
def _isolate():
    _reset_decorated_for_tests()
    yield
    _reset_decorated_for_tests()


def _write_node(nodes_dir, name: str, body: str) -> None:
    node_dir = nodes_dir / name
    node_dir.mkdir(parents=True)
    (node_dir / "node.py").write_text(body)
    (node_dir / "__init__.py").write_text("")


def test_discovers_registers_and_executes(tmp_path):
    _write_node(tmp_path, "my-greeter", _SCAFFOLD)

    registry = NodeRegistry()
    count = load_user_nodes(registry, str(tmp_path))

    assert count == 1
    assert "my-greeter" in registry.node_names()

    # The registered handler validates input and serializes typed output.
    handler = registry.get("my-greeter")
    assert handler is not None
    assert handler.execute(Context(id="t", workflow_name="wf", workflow_path="/wf"), {"name": "Blok"}) == {
        "message": "Hello, Blok!"
    }


def test_missing_or_unset_dir_is_noop():
    registry = NodeRegistry()
    assert load_user_nodes(registry, None) == 0
    assert load_user_nodes(registry, "/no/such/dir/xyz") == 0
    assert registry.node_names() == []


def test_only_new_handlers_registered_is_additive(tmp_path):
    # A handler collected BEFORE the call (e.g. an SDK example) must not be
    # re-registered by load_user_nodes — only nodes discovered this call count.
    from blok import node

    @node("pre-existing", "already collected")
    def _pre(ctx, _input):  # noqa: ANN001
        return {}

    _write_node(tmp_path, "fresh", _SCAFFOLD.replace("my-greeter", "fresh"))

    registry = NodeRegistry()
    count = load_user_nodes(registry, str(tmp_path))

    assert count == 1  # only "fresh", not "pre-existing"
    assert "fresh" in registry.node_names()
    assert "pre-existing" not in registry.node_names()


def test_bad_node_is_skipped_not_fatal(tmp_path):
    _write_node(tmp_path, "broken", "raise RuntimeError('boom')\n")
    _write_node(tmp_path, "good", _SCAFFOLD.replace("my-greeter", "good"))

    registry = NodeRegistry()
    count = load_user_nodes(registry, str(tmp_path))

    assert count == 1  # the good node still loads
    assert "good" in registry.node_names()
