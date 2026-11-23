"""The shared tests in conformance/cases, run against this kernel. The TypeScript kernel runs the same files."""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from conformance_nodes import Ports, nodes

from blok import (
    BlokError,
    NeverHappens,
    Signature,
    Span,
    UnreadableSchedule,
    http_binding,
    next_run,
    parse_schedule,
    runtime,
    workflow_unit,
)
from blok.http import answer, signed

CASES = Path(__file__).parents[2] / "conformance" / "cases"


def read(file: str) -> Any:
    return json.loads((CASES / file).read_text(encoding="utf-8"))


def secret_of(value: Any) -> str:
    """A secret is written as the sentence it is made from, so no file holds anything that reads as a real one."""
    if isinstance(value, str):
        return value
    sentence = value.get("whsecOf", value.get("base64Of"))
    encoded = base64.b64encode(sentence.encode()).decode()
    return f"whsec_{encoded}" if "whsecOf" in value else encoded


def workflow_id(name: str, workflow: dict[str, Any]) -> str:
    return f"workflows/{name}@{(workflow.get('version') or '1').split('.')[0]}"


def prepare(one: dict[str, Any]):
    """The nodes and the case's workflows, loaded the way a kernel with no check of its own loads them."""
    units = {unit.id: unit for unit in nodes}
    env = {key: secret_of(value) for key, value in (one.get("env") or {}).items()}
    workflows = {workflow_id(name, workflow): workflow for name, workflow in (one.get("workflows") or {}).items()}
    for id, workflow in workflows.items():
        request = (one.get("built") or {}).get(id, {}).get("request")
        units[id] = workflow_unit(id, workflow, units, is_workflow=workflows.__contains__, env=env, request=request)
    return units, env, workflows


class Recorder:
    def __init__(self) -> None:
        self.ports = Ports()
        self.spans: list[Span] = []
        self.logged: list[str] = []
        self.call = runtime(ports=self.ports, log=self, on_span=self.spans.append).call

    def info(self, message: str, data: Any = None) -> None:
        pass

    def error(self, message: str, data: Any = None) -> None:
        self.logged.append(message)


def span_of(span: Span) -> dict[str, Any]:
    shown = {"id": span.id, "kind": span.kind, "parent": span.parent, "key": span.key}
    shown.update(attempts=span.attempts, ok=span.ok, error=span.error)
    return {key: value for key, value in shown.items() if value is not None}


def cases():
    for file in ["call.json", "workflow.json", "request.json", "http.json"]:
        for one in read(file)["cases"]:
            yield pytest.param(one, id=f"{file}: {one['name']}")


@pytest.mark.parametrize("one", list(cases()))
def test_case(one: dict[str, Any]) -> None:
    asyncio.run(check(one))


async def check(one: dict[str, Any]) -> None:
    units, env, workflows = prepare(one)

    for index, run in enumerate(one.get("runs") or []):
        seen = Recorder()
        got: dict[str, Any] = {}
        wanted: dict[str, Any] = {}
        try:
            output = await seen.call(units[run["call"]], run["input"])
            if "output" in run:
                got["output"] = output
        except BlokError as err:
            got["error"] = {"code": err.code, "node": err.node}
            if (run.get("error") or {}).get("message"):
                got["error"]["message"] = err.message
        if "output" in run:
            wanted["output"] = run["output"]
        if "error" in run:
            wanted["error"] = run["error"]
        if "journal" in run:
            got["journal"], wanted["journal"] = seen.ports.journal, run["journal"]
        if "journalInAnyOrder" in run:
            got["journalInAnyOrder"], wanted["journalInAnyOrder"] = (
                sorted(seen.ports.journal),
                sorted(run["journalInAnyOrder"]),
            )
        if "journalLacks" in run:
            # Notes that must not be in the journal: what was never started.
            got["journalLacks"] = [note for note in run["journalLacks"] if note not in seen.ports.journal]
            wanted["journalLacks"] = run["journalLacks"]
        if "spans" in run:
            got["spans"], wanted["spans"] = [span_of(span) for span in seen.spans], run["spans"]
        if "logged" in run:
            got["logged"], wanted["logged"] = seen.logged, run["logged"]
        assert {"run": index, "input": run["input"], **got} == {"run": index, "input": run["input"], **wanted}

    for index, sent in enumerate(one.get("requests") or []):
        seen = Recorder()
        binding = http_binding(workflows[sent["to"]], units[sent["to"]], env)
        assert binding is not None
        asked = sent["request"]
        raw = sent.get("raw")
        request = {
            "method": asked["method"],
            "body": asked["body"] if "body" in asked else ({} if raw is None else json.loads(raw)),
            "query": asked.get("query", {}),
            "params": asked.get("params", {}),
            "headers": asked.get("headers", {}),
        }
        now = (lambda at=sent["now"]: at) if "now" in sent else None
        status, body = await answer(binding, seen.call, request, raw=raw, log=seen, now=now)
        got = {"status": status, "body": body}
        wanted = {"status": sent["status"], "body": sent["body"]}
        if "journal" in sent:
            got["journal"], wanted["journal"] = seen.ports.journal, sent["journal"]
        if "logged" in sent:
            got["logged"], wanted["logged"] = seen.logged, sent["logged"]
        assert {"request": index, **got} == {"request": index, **wanted}


def signatures():
    for group in read("http.json")["signatures"]:
        yield pytest.param(group, id=f"http.json: {group['name']}")


@pytest.mark.parametrize("group", list(signatures()))
def test_signature(group: dict[str, Any]) -> None:
    given = group["signature"]
    signature = Signature(
        scheme=given["scheme"],
        secret=secret_of(given["secret"]),
        header=given.get("header"),
        encoding=given.get("encoding"),
        prefix=given.get("prefix"),
    )
    for index, one in enumerate(group["checks"]):
        accepted = signed(signature, one["raw"], one["headers"], one.get("now"))
        assert {"check": index, "accepted": accepted} == {"check": index, "accepted": one["accepted"]}
        # The bytes are what is signed, however they are handed over.
        as_bytes = signed(signature, one["raw"].encode(), one["headers"], one.get("now"))
        assert {"check": index, "bytes": as_bytes} == {"check": index, "bytes": one["accepted"]}


def test_schedule() -> None:
    content = read("schedule.json")
    count = 0
    for times in [*content["next"], *content["grid"]]:
        at = datetime.fromisoformat(times["after"].replace("Z", "+00:00"))
        ours = []
        for _ in times["runs"]:
            at = next_run(parse_schedule(times["schedule"]), at, times["zone"])
            ours.append(at.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        assert {**times, "runs": ours} == times
        count += len(ours)
    assert sum(len(times["runs"]) for times in content["grid"]) == 14 * 4 * 4 * 6

    for one in content["unreadable"]:
        with pytest.raises(UnreadableSchedule) as refused:
            parse_schedule(one["schedule"])
        assert {"schedule": one["schedule"], "problem": str(refused.value)} == one
    for schedule in content["never"]:
        with pytest.raises(NeverHappens, match="it never happens"):
            next_run(parse_schedule(schedule), datetime.fromtimestamp(0, UTC))
    for zone in content["notAZone"]:
        with pytest.raises(ValueError, match="is not a time zone"):
            next_run(parse_schedule("0 0 * * *"), datetime.fromtimestamp(0, UTC), zone)
