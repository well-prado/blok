"""The sidecar must never boot serving zero user nodes in silence (#1064).

`bin/serve.py` used to swallow every ImportError from the typed-node loader
and return 0. On an interpreter older than 3.11 — macOS's stock `python3` is
3.9 — `blok.node.capability_manifest` cannot import `typing.NotRequired`, so
the sidecar started, logged `… 5 nodes, 0 user`, and every `runtime.python3`
step failed with "node not found" while nothing said the interpreter was too
old.
"""

import importlib.util
import logging
import re
import sys
from pathlib import Path

import pytest

SDK_ROOT = Path(__file__).resolve().parents[1]
SERVE_PY = SDK_ROOT / "bin" / "serve.py"
LOADER = "blok.node.define_node"


def _serve():
    """Import `bin/serve.py` as a module (it is a script, not a package)."""
    spec = importlib.util.spec_from_file_location("blok_bin_serve", SERVE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def broken_loader(monkeypatch):
    """`None` in `sys.modules` makes `from … import …` raise ImportError.

    Stands in for the real failures: `NotRequired` on 3.10, no pydantic.
    """
    monkeypatch.setitem(sys.modules, LOADER, None)


def test_exits_when_nodes_were_requested_but_the_loader_cannot_import(broken_loader, monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("BLOK_NODES_DIR", str(tmp_path))
    serve = _serve()

    with caplog.at_level(logging.ERROR, logger="blok.serve"), pytest.raises(SystemExit) as exit_info:
        serve._load_user_nodes(object())

    assert exit_info.value.code == 1
    message = caplog.text
    assert str(tmp_path) in message, "the diagnostic must name the nodes dir that was asked for"
    assert LOADER in message, "the diagnostic must name the module that failed to import"
    assert f"Python >= {serve.REQUIRED_PYTHON}" in message
    assert f"Python {'.'.join(str(part) for part in sys.version_info[:3])}" in message


def test_no_nodes_dir_keeps_the_import_optional(broken_loader, monkeypatch):
    """Nothing was asked for, so a missing optional loader is still a no-op."""
    monkeypatch.delenv("BLOK_NODES_DIR", raising=False)
    assert _serve()._load_user_nodes(object()) == 0


def test_declared_python_floor_covers_the_typing_features_the_sdk_imports():
    """`typing.NotRequired` is 3.11+; `requires-python` must not promise 3.10."""
    manifest = (SDK_ROOT / "blok" / "node" / "capability_manifest.py").read_text()
    needs_311 = re.search(r"^from typing import .*\bNotRequired\b", manifest, re.MULTILINE)

    declared = re.search(r'^requires-python = ">=(\d+)\.(\d+)"', (SDK_ROOT / "pyproject.toml").read_text(), re.MULTILINE)
    assert declared, "pyproject.toml must declare requires-python"
    floor = (int(declared.group(1)), int(declared.group(2)))

    if needs_311:
        assert floor >= (3, 11), "capability_manifest.py imports typing.NotRequired, which needs Python 3.11"
    assert floor >= (3, 10)
