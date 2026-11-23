"""What `blokctl` asks this kernel: `python -m blok contracts` and `python -m blok run <id>`.

Both answer with one JSON document on stdout, so the tool that reads them needs to know nothing about Python.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

from .kernel import VERSION, BlokError, Runtime, Span, contract, fingerprint
from .project import discover_nodes, load_project


def contracts(dir: Path) -> dict[str, Any]:
    """Every node's contract, in the language-neutral form, and what could not be loaded."""
    problems: list[str] = []
    nodes = []
    for unit in discover_nodes(dir / "nodes", problems).values():
        try:
            nodes.append({**contract(unit), "fingerprint": fingerprint(unit)})
        except Exception as err:
            problems.append(str(err))
    return {
        "blok": 1,
        "language": "python",
        "kernel": VERSION,
        #: The kinds of trigger this kernel has an adapter for.
        "starts": ["http", "cron", "queue", "mcp"],
        "nodes": nodes,
        "problems": problems,
    }


def _ports(dir: Path, given: str | None) -> Any:
    """The ports to run with: `--ports <file>`, or the `ports` the project exports from its ports package."""
    if given:
        file = Path(given).resolve()
        if not file.is_file():
            raise FileNotFoundError(f"{given} does not exist.")
        spec = importlib.util.spec_from_file_location("blok_run_ports", file)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        shown = given
    else:
        if not (dir / "ports" / "__init__.py").is_file() and not (dir / "ports.py").is_file():
            raise FileNotFoundError("There is no ports package to take the ports from.")
        module = importlib.import_module("ports")
        shown = "ports"
    if not hasattr(module, "ports"):
        raise LookupError(f"{shown} has no `ports`. Define one, or pass a file that does with --ports.")
    return module.ports


async def run(dir: Path, given: str, text: str | None, ports_file: str | None) -> dict[str, Any]:
    """Runs a node with the input given, or a workflow with the request given, from what `blokctl build` wrote."""
    project = load_project(dir, env=os.environ)
    workflows = dict(project.workflows)
    matches = [id for id in workflows if given in (id, id.split("@")[0], id.split("@")[0].removeprefix("workflows/"))]
    if not matches:
        # A node answers to its id, and to its id without the version when that names one node.
        named = [id for id in project.units if id not in workflows and given in (id, id.split("@")[0])]
        matches = sorted(named, key=lambda id: int(id.split("@")[1]))[-1:]
    if not matches:
        return {"ok": False, "problems": [f'"{given}" is not a node or a workflow. Run "blokctl list" to see them.']}
    id = matches[0]
    try:
        input = json.loads(text if text is not None else "{}")
    except ValueError as err:
        return {"ok": False, "problems": [f"--input is not valid JSON: {err}"]}
    # Run with no input, a workflow on a schedule gets what its schedule would give it.
    scheduled = ((workflows.get(id) or {}).get("trigger") or {}).get("cron")
    if text is None and scheduled and "body" in scheduled:
        input = {"body": scheduled["body"]}
    try:
        ports = _ports(dir, ports_file)
    except Exception as err:
        return {"ok": False, "problems": [str(err)]}

    spans: list[Span] = []
    trace = lambda: [  # noqa: E731
        {key: value for key, value in {**vars(span), "ms": round(span.ms, 2)}.items() if value is not None}
        for span in spans
    ]
    try:
        output = await Runtime(ports=ports, on_span=spans.append).call(project.units[id], input)
        return {"ok": True, "id": id, "output": output, "spans": trace()}
    except BlokError as err:
        error = {"code": err.code, "message": err.message, "node": err.node}
        return {"ok": False, "id": id, "error": error, "spans": trace()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m blok", description="What blokctl asks the Python kernel.")
    parser.add_argument("command", choices=["contracts", "run"])
    parser.add_argument("id", nargs="?")
    parser.add_argument("--dir", default=".", help="The folder that holds nodes/ and .blok/.")
    parser.add_argument("--input")
    parser.add_argument("--ports")
    args = parser.parse_args(argv)
    dir = Path(args.dir).resolve()
    # A node imports the project's own modules, such as `ports`, from the project folder.
    sys.path.insert(0, str(dir))

    # Whatever a node prints while it loads or runs must not end up inside the JSON.
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        if args.command == "contracts":
            result = contracts(dir)
        elif not args.id:
            result = {"ok": False, "problems": ["Say what to run: python -m blok run <id>."]}
        else:
            try:
                result = asyncio.run(run(dir, args.id, args.input, args.ports))
            except Exception as err:
                result = {"ok": False, "problems": [str(err)]}
    finally:
        sys.stdout = out
    json.dump(result, out, ensure_ascii=False)
    out.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
