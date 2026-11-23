"""Loading a project from disk, and refusing one that is not what `blokctl build` checked."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from blok import BlokError, CronBinding, HttpBinding, QueueBinding, ToolBinding, discover_nodes, load_app, load_project
from blok.testing import call

FIXTURE = Path(__file__).parent / "fixture"
BUILT = FIXTURE / "built" / "workflows"
#: A secret made up for these tests. It is built from a sentence, so no line here reads as a real one.
ENV = {"HOOK_SECRET": "whsec_" + __import__("base64").b64encode(b"a secret made up for these tests").decode()}


def copy(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    shutil.copytree(FIXTURE, project, ignore=shutil.ignore_patterns("__pycache__", ".blok", "blok"))
    return project


def test_a_project_loads_from_its_folders_and_from_what_the_build_wrote():
    project = load_project(FIXTURE, workflows=BUILT, env=ENV)
    assert sorted(project.units) == [
        "shop/price@1",
        "shop/record@1",
        "workflows/events@1",
        "workflows/hook@1",
        "workflows/nightly@1",
        "workflows/note@1",
        "workflows/price@1",
        "workflows/quote@1",
    ]
    kinds = sorted((type(binding).__name__, binding.unit.id) for binding in project.bindings)
    assert kinds == [
        ("CronBinding", "workflows/nightly@1"),
        ("HttpBinding", "workflows/hook@1"),
        ("HttpBinding", "workflows/price@1"),
        ("HttpBinding", "workflows/quote@1"),
        ("QueueBinding", "workflows/events@1"),
        ("ToolBinding", "workflows/note@1"),
        ("ToolBinding", "workflows/price@1"),
    ]
    by = {(type(binding), binding.unit.id): binding for binding in project.bindings}
    route = by[HttpBinding, "workflows/price@1"]
    assert (route.method, route.path, route.success, route.status) == ("POST", "/price", None, {"unknown_sku": 404})
    hook = by[HttpBinding, "workflows/hook@1"]
    assert (hook.success, hook.signature.scheme, hook.signature.secret) == (202, "standard", ENV["HOOK_SECRET"])
    cron = by[CronBinding, "workflows/nightly@1"]
    assert (cron.schedule, cron.timezone, cron.body) == ("0 2 * * *", "UTC", {"note": "nightly"})
    queue = by[QueueBinding, "workflows/events@1"]
    assert (queue.queue, queue.concurrency) == ("events", 2)
    tool = by[ToolBinding, "workflows/price@1"]
    assert (tool.tool, tool.description) == ("price_order", "Prices a quantity of one product, without ordering it.")
    assert tool.input["required"] == ["sku", "qty"] and tool.input["type"] == "object"
    assert tool.output == {
        "type": "object",
        "properties": {"totalCents": {"type": "integer"}},
        "required": ["totalCents"],
        "additionalProperties": False,
    }
    # A tool with no name of its own is called by its file name.
    assert by[ToolBinding, "workflows/note@1"].tool == "note"


def test_the_loaded_app_runs_a_workflow_with_the_ports_it_was_given():
    from ports import memory_ports

    ports = memory_ports()
    blok = load_app(FIXTURE, ports=ports, workflows=BUILT, env=ENV)
    import asyncio

    assert asyncio.run(blok.call(blok.units["workflows/price@1"], {"body": {"sku": "desk", "qty": 2}})) == {
        "totalCents": 36000
    }
    assert asyncio.run(blok.call(blok.units["workflows/nightly@1"], {"body": {"note": "n"}})) == {
        "note": "n",
        "position": 1,
    }
    assert ports.journal == ["n"]
    with pytest.raises(BlokError) as refused:
        asyncio.run(blok.call(blok.units["workflows/price@1"], {"body": {"sku": "desk"}}))
    assert refused.value.message == "The request is missing: body.qty."


def test_a_signed_route_needs_its_secret_when_the_project_loads():
    with pytest.raises(RuntimeError) as refused:
        load_project(FIXTURE, workflows=BUILT)
    assert str(refused.value) == (
        "workflows/hook@1 checks a signature with the secret in HOOK_SECRET, and no such value was given. "
        "Pass it in `env`, for example `env=os.environ`."
    )


def test_an_app_does_not_start_on_a_build_that_was_checked_against_other_contracts(tmp_path: Path):
    project = copy(tmp_path)
    built = project / "built" / "workflows"
    load_project(project, workflows=built, env=ENV)

    # The node answers with another field than the one the workflows were checked against.
    node_file = project / "nodes" / "shop" / "price" / "v1" / "node.py"
    node_file.write_text(node_file.read_text().replace("total_cents", "total"))
    with pytest.raises(RuntimeError) as refused:
        load_project(project, workflows=built, env=ENV)
    assert str(refused.value) == (
        'The app does not match what "blokctl build" checked:\n'
        "- shop/price@1 takes, answers with or fails with something else than when the app was built.\n"
        'Run "blokctl build" again.'
    )

    # A node that is gone, and a workflow file the build did not write.
    shutil.rmtree(project / "nodes" / "shop" / "price")
    (built / "extra.json").write_text(json.dumps({"name": "Extra", "steps": []}))
    with pytest.raises(RuntimeError) as refused:
        load_project(project, workflows=built, env=ENV)
    assert str(refused.value).splitlines()[1:3] == [
        "- shop/price@1 was there when the app was built, and is gone.",
        f"- workflows/extra@1 is in {built} and was not part of the build.",
    ]


def test_a_logic_change_that_keeps_the_contract_needs_no_new_build(tmp_path: Path):
    project = copy(tmp_path)
    node_file = project / "nodes" / "shop" / "price" / "v1" / "node.py"
    node_file.write_text(
        node_file.read_text()
        .replace('"book": 2500', '"book": 2600')
        .replace("Prices a quantity", "Prices any quantity")
    )
    loaded = load_project(project, workflows=project / "built" / "workflows", env=ENV)
    assert call(loaded.units["shop/price@1"], {"sku": "book", "qty": 1}) == {"total_cents": 2600}


def test_what_is_missing_says_what_to_run(tmp_path: Path):
    project = copy(tmp_path)
    (project / "built" / "app.json").unlink()
    with pytest.raises(FileNotFoundError, match='app.json is missing. Run "blokctl build" again'):
        load_project(project, workflows=project / "built" / "workflows", env=ENV)
    with pytest.raises(
        FileNotFoundError, match='There are no built workflows at .* Run "blokctl build" first, or use "blokctl dev".'
    ):
        load_project(project, env=ENV)


def test_the_folder_a_node_lives_in_is_its_id(tmp_path: Path):
    nodes = tmp_path / "nodes"
    source = (FIXTURE / "nodes" / "shop" / "price" / "v1" / "node.py").read_text()

    def put(where: str, text: str = source) -> None:
        (nodes / where).parent.mkdir(parents=True, exist_ok=True)
        (nodes / where).write_text(text)

    put("shop/price/v1/node.py")
    put("user-accounts/sign-up/v2/node.py", source.replace("shop/price@1", "user-accounts/sign-up@2"))
    assert sorted(discover_nodes(nodes)) == ["shop/price@1", "user-accounts/sign-up@2"]
    assert discover_nodes(tmp_path / "nowhere") == {}

    put("shop/cost/v1/node.py")
    put("price/v1/node.py")
    put(
        "shop/two/v1/node.py",
        source.replace("shop/price@1", "shop/two@1")
        + "\nother = node(id='shop/other@1', input=Input, output=Output, run=run)\n",
    )
    put("shop/none/v1/node.py", "x = 1\n")
    put("shop/broken/v1/node.py", "def (:\n")
    put("shop/price/final/node.py")
    problems: list[str] = []
    assert sorted(discover_nodes(nodes, problems)) == ["shop/price@1", "user-accounts/sign-up@2"]
    assert problems[:5] == [
        "price/v1/node.py is not where a node goes. A node lives at <module>/<node>/v<N>/node.py.",
        "shop/broken/v1/node.py could not be loaded: " + problems[1].split(": ", 1)[1],
        'shop/cost/v1/node.py declares "shop/price@1", but its path says "shop/cost@1".',
        "shop/none/v1/node.py must define one node, with `node(...)`.",
        "shop/price/final/node.py is not where a node goes. A node lives at <module>/<node>/v<N>/node.py.",
    ]
    assert "SyntaxError" in problems[1]
    assert problems[5] == "shop/two/v1/node.py defines 2 nodes. A node file defines one."
    # Without a list to write to, the first one stops the load.
    with pytest.raises(Exception, match="price/v1/node.py is not where a node goes"):
        discover_nodes(nodes)


def ask(*args: str, cwd: Path = FIXTURE) -> dict:
    said = subprocess.run([sys.executable, "-m", "blok", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return json.loads(said.stdout)


def test_the_kernel_prints_its_contracts_for_blokctl(tmp_path: Path):
    said = ask("contracts")
    assert (said["blok"], said["language"], said["problems"]) == (1, "python", [])
    assert [node["id"] for node in said["nodes"]] == ["shop/price@1", "shop/record@1"]
    price = said["nodes"][0]
    assert price["input"]["required"] == ["sku", "qty"] and price["errors"] == ["unknown_sku"]
    assert price["output"] == {
        "type": "object",
        "properties": {"total_cents": {"type": "integer"}},
        "required": ["total_cents"],
        "additionalProperties": False,
    }
    manifest = json.loads((FIXTURE / "built" / "app.json").read_text())
    assert {node["id"]: node["fingerprint"] for node in said["nodes"]} == manifest["nodes"]

    # A node file that prints, and one that cannot be loaded: the answer is still one JSON document.
    project = copy(tmp_path)
    noisy = project / "nodes" / "shop" / "record" / "v1" / "node.py"
    noisy.write_text("print('loading')\n" + noisy.read_text())
    (project / "nodes" / "shop" / "price" / "v1" / "node.py").write_text("import nothing_like_this\n")
    said = ask("contracts", "--dir", str(project))
    assert [node["id"] for node in said["nodes"]] == ["shop/record@1"]
    assert said["problems"] == [
        "shop/price/v1/node.py could not be loaded: ModuleNotFoundError(\"No module named 'nothing_like_this'\")"
    ]
