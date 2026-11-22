"""Loading a project from disk. Nothing is registered by hand: the folder a node lives in is its id,
and the workflows are the JSON files that `blokctl build` wrote.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .kernel import Log, Runtime, Span, Unit, console_log, fingerprint
from .workflow import Binding, bindings_of, workflow_unit

_VERSION = re.compile(r"v[1-9][0-9]*")
_SKIP = {"__pycache__", "node_modules"}


def discover_nodes(dir: str | os.PathLike[str], problems: list[str] | None = None) -> dict[str, Unit]:
    """Imports every `<module>/<node>/v<N>/node.py` under `dir` and refuses one whose id disagrees with its path.

    A folder that does not exist holds no nodes. With `problems`, a file that cannot be loaded is written
    there and the rest are still loaded. Without it, the first one raises.
    """
    units: dict[str, Unit] = {}
    root = Path(dir)
    if not root.is_dir():
        return units
    files = sorted(
        path.relative_to(root)
        for path in root.rglob("node.py")
        if not any(part in _SKIP or part.startswith(".") for part in path.relative_to(root).parts)
    )
    for file in files:
        try:
            unit = _load(root, file)
        except Exception as err:
            if problems is None:
                raise
            problems.append(
                str(err) if isinstance(err, NodeFileError) else f"{file.as_posix()} could not be loaded: {err!r}"
            )
            continue
        units[unit.id] = unit
    return units


class NodeFileError(Exception):
    """Something the author of a node file can fix, said in a sentence."""


def _only_node(path: Path, shown: str) -> Unit:
    """Runs one node file and answers with the node it defines."""
    # A module name of its own, so that two node files never shadow each other.
    name = "blok_nodes." + re.sub(r"[^A-Za-z0-9_]", "_", str(path.resolve())[: -len(".py")])
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise NodeFileError(f"{shown} could not be read as Python.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    found = {id(value): value for value in vars(module).values() if isinstance(value, Unit)}
    if len(found) != 1:
        raise NodeFileError(
            f"{shown} must define one node, with `node(...)`."
            if not found
            else f"{shown} defines {len(found)} nodes. A node file defines one."
        )
    return next(iter(found.values()))


def _load(root: Path, file: Path) -> Unit:
    shown = file.as_posix()
    *where, version, _name = file.parts
    if len(where) < 2 or not _VERSION.fullmatch(version):
        raise NodeFileError(f"{shown} is not where a node goes. A node lives at <module>/<node>/v<N>/node.py.")
    expected = f"{'/'.join(where)}@{version[1:]}"
    unit = _only_node(root / file, shown)
    if unit.id != expected:
        raise NodeFileError(f'{shown} declares "{unit.id}", but its path says "{expected}".')
    return unit


def workflow_id(name: str, workflow: Mapping[str, Any]) -> str:
    """The file name is the id: `checkout.json` at version 1.x is `workflows/checkout@1`."""
    return f"workflows/{name}@{str(workflow.get('version') or '1').split('.')[0]}"


def read_built_workflows(dir: str | os.PathLike[str]) -> list[tuple[str, dict[str, Any]]]:
    """Reads the workflow JSON files that `blokctl build` wrote."""
    folder = Path(dir)
    if not folder.is_dir():
        raise FileNotFoundError(
            f'There are no built workflows at {folder}. Run "blokctl build" first, or use "blokctl dev".'
        )
    out = []
    for file in sorted(folder.glob("*.json")):
        workflow = json.loads(file.read_text(encoding="utf-8"))
        out.append((workflow_id(file.stem, workflow), workflow))
    return out


@dataclass(frozen=True)
class Project:
    #: Every node and every workflow, by id. Any of them can be passed to `call`.
    units: dict[str, Unit]
    workflows: list[tuple[str, dict[str, Any]]]
    #: What each workflow reads and answers with, as `blokctl build` worked it out.
    shapes: dict[str, dict[str, Any]]
    #: One per trigger: a route, a schedule, a queue or a tool. An adapter takes the kind it serves.
    bindings: list[Binding]


def load_project(
    dir: str | os.PathLike[str],
    *,
    nodes: str | os.PathLike[str] | None = None,
    workflows: str | os.PathLike[str] | None = None,
    env: Mapping[str, Any] | None = None,
) -> Project:
    """Loads the nodes and the built workflows, and refuses to go on if the nodes are not the ones the build checked.

    This kernel runs workflows and does not check them: `blokctl build` does, and writes what it found to
    `.blok/app.json`. So the two have to be about the same nodes, and this is where that is made sure.
    """
    root = Path(dir)
    built = Path(workflows) if workflows else root / ".blok" / "workflows"
    units = discover_nodes(nodes or root / "nodes")
    found = read_built_workflows(built)
    manifest_file = built.parent / "app.json"
    if not manifest_file.is_file():
        raise FileNotFoundError(
            f'{manifest_file} is missing. Run "blokctl build" again: it writes that file beside the workflows.'
        )
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))

    changed = []
    for id, promised in (manifest.get("nodes") or {}).items():
        unit = units.get(id)
        if unit is None:
            changed.append(f"{id} was there when the app was built, and is gone.")
        elif fingerprint(unit) != promised:
            changed.append(f"{id} takes, answers with or fails with something else than when the app was built.")
    known = manifest.get("workflows") or {}
    for id, _workflow in found:
        if id not in known:
            changed.append(f"{id} is in {built} and was not part of the build.")
    if changed:
        listed = "\n- ".join(changed)
        raise RuntimeError(
            f'The app does not match what "blokctl build" checked:\n- {listed}\nRun "blokctl build" again.'
        )

    surroundings = dict(env or {})
    own = {id for id, _workflow in found}
    for id in own:
        if id in units:
            raise RuntimeError(f'Two units claim the id "{id}".')
    shapes: dict[str, dict[str, Any]] = {}
    for id, workflow in found:
        learned = known[id]
        request = learned.get("request") or {"type": "object", "properties": {}}
        shapes[id] = {
            "input": (request.get("properties") or {}).get("body") or {"type": "object", "properties": {}},
            "output": learned.get("answers"),
            "request": request,
            "errors": learned.get("errors") or [],
        }
        units[id] = workflow_unit(id, workflow, units, is_workflow=own.__contains__, env=surroundings, request=request)
    bindings = [
        binding for id, workflow in found for binding in bindings_of(id, workflow, units[id], shapes[id], surroundings)
    ]
    return Project(units=units, workflows=found, shapes=shapes, bindings=bindings)


@dataclass(frozen=True)
class App:
    """A loaded project that can run: what every adapter starts from."""

    units: dict[str, Unit]
    workflows: list[tuple[str, dict[str, Any]]]
    shapes: dict[str, dict[str, Any]]
    bindings: list[Binding]
    call: Callable[..., Awaitable[Any]]
    log: Log


def load_app(
    dir: str | os.PathLike[str],
    *,
    ports: Any,
    env: Mapping[str, Any] | None = None,
    log: Log | None = None,
    on_span: Callable[[Span], None] | None = None,
    nodes: str | os.PathLike[str] | None = None,
    workflows: str | os.PathLike[str] | None = None,
) -> App:
    """Loads the project once, for an app that starts more than one thing from it:

        blok = load_app(Path(__file__).parent, ports=ports, env=os.environ)
        blok_fastapi(app, blok)
        await start_cron(blok)

    `env` is what `${env.NAME}` reads in a workflow, and where a signed trigger finds its secret.
    """
    project = load_project(dir, nodes=nodes, workflows=workflows, env=env)
    log = log or console_log
    running = Runtime(ports=ports, log=log, on_span=on_span)
    return App(
        units=project.units,
        workflows=project.workflows,
        shapes=project.shapes,
        bindings=project.bindings,
        call=running.call,
        log=log,
    )
