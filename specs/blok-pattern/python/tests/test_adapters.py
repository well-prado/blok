"""What starts a workflow from outside: a FastAPI route, a schedule, a queue and a tool for an agent."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from mcp import Client
from starlette.testclient import TestClient

from blok import load_app
from blok.cron import CronRun, start_cron
from blok.fastapi import blok_fastapi
from blok.mcp import blok_mcp
from blok.queue import Refused, memory_queue, start_queues

FIXTURE = Path(__file__).parent / "fixture"
SENTENCE = b"a secret made up for these tests"
ENV = {"HOOK_SECRET": "whsec_" + base64.b64encode(SENTENCE).decode()}
NOW = 1_800_000_000


class Log:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def info(self, message: str, data: Any = None) -> None:
        pass

    def error(self, message: str, data: Any = None) -> None:
        self.errors.append(message)


def load():
    from ports import memory_ports

    ports, log = memory_ports(), Log()
    return load_app(FIXTURE, ports=ports, workflows=FIXTURE / "built" / "workflows", env=ENV, log=log), ports, log


def sign(body: str, at: int = NOW, id: str = "msg_1") -> dict[str, str]:
    """What a sender of Standard Webhooks puts on a request, made with Python's own HMAC."""
    made = base64.b64encode(hmac.new(SENTENCE, f"{id}.{at}.{body}".encode(), hashlib.sha256).digest()).decode()
    return {"webhook-id": id, "webhook-timestamp": str(at), "webhook-signature": f"v1,{made}"}


def test_fastapi_serves_every_route_beside_the_apps_own():
    blok, ports, log = load()
    app = FastAPI()

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    blok_fastapi(app, blok, now=lambda: NOW * 1000)
    client = TestClient(app)

    assert client.get("/health").json() == {"ok": True}
    said = client.post("/price", json={"sku": "desk", "qty": 2})
    assert (said.status_code, said.headers["content-type"], said.json()) == (
        200,
        "application/json",
        {"totalCents": 36000},
    )
    said = client.post("/price", json={"sku": "sofa", "qty": 1})
    assert (said.status_code, said.json()) == (
        404,
        {"error": "unknown_sku", "message": 'There is no product "sofa".', "node": "shop/price@1"},
    )
    said = client.post("/price", json={"sku": "desk"})
    assert (said.status_code, said.json()["message"]) == (400, "The request is missing: body.qty.")
    said = client.post("/price", content='{"sku":', headers={"content-type": "application/json"})
    assert (said.status_code, said.json()) == (400, {"error": "invalid_input", "message": "The body is not JSON."})
    # A path parameter and a query string are text, and become what the node asks for.
    said = client.get("/shops/s1/prices/book?qty=3")
    assert (said.status_code, said.json()) == (200, {"shop": "s1", "totalCents": 7500})
    said = client.get("/shops/s1/prices/book?qty=three")
    assert (said.status_code, said.json()["node"]) == (400, "shop/price@1")
    # The routes are Blok's, so they stay out of the description FastAPI writes of its own.
    assert sorted(client.get("/openapi.json").json()["paths"]) == ["/health"]

    event = '{"id":"evt_1"}'
    signed = {"content-type": "application/json", **sign(event)}
    said = client.post("/hooks", content=event, headers=signed)
    assert (said.status_code, said.json()) == (202, {"note": "evt_1", "position": 1})
    refused = {"error": "invalid_signature", "message": "The signature does not match."}
    said = client.post("/hooks", content=event.replace("evt_1", "evt_2"), headers=signed)
    assert (said.status_code, said.json()) == (401, refused)
    assert client.post("/hooks", content=event).status_code == 401
    old = {"content-type": "application/json", **sign(event, NOW - 600)}
    assert client.post("/hooks", content=event, headers=old).status_code == 401
    assert ports.journal == ["evt_1"]

    # A failure nobody planned for says nothing about what broke, and the log has it.
    said = client.post(
        "/hooks", content='{"id":"break"}', headers={"content-type": "application/json", **sign('{"id":"break"}')}
    )
    assert (said.status_code, said.json()) == (
        500,
        {"error": "unexpected", "message": "The server could not complete the request."},
    )
    assert log.errors == ['workflows/hook@1 failed with "unexpected" at shop/record@1: the journal is full']


class Clock:
    """A clock a test moves by hand. Sleeping moves it on to when the sleeper wanted to wake."""

    def __init__(self, at: str) -> None:
        self.ms = datetime.fromisoformat(at).replace(tzinfo=UTC).timestamp() * 1000
        self.turns = 0

    def now(self) -> float:
        return self.ms

    async def sleep(self, seconds: float) -> None:
        self.turns += 1
        if self.turns > 4:
            await asyncio.Event().wait()
        self.ms += seconds * 1000
        await asyncio.sleep(0)


def test_a_schedule_runs_its_workflow_with_the_body_its_trigger_gives():
    async def scenario() -> None:
        blok, ports, log = load()
        clock = Clock("2026-03-10T01:30:00")
        ran: list[CronRun] = []
        jobs = await start_cron(blok, timers=clock, on_run=ran.append)
        job = jobs.jobs[0]
        assert (job.id, job.schedule, job.timezone) == ("workflows/nightly@1", "0 2 * * *", "UTC")
        assert job.next().isoformat() == "2026-03-10T02:00:00+00:00"
        for _ in range(20):
            await asyncio.sleep(0)
        await jobs.stop()
        assert [(run.id, run.at.isoformat(), run.ok, run.error) for run in ran[:2]] == [
            ("workflows/nightly@1", "2026-03-10T02:00:00+00:00", True, None),
            ("workflows/nightly@1", "2026-03-11T02:00:00+00:00", True, None),
        ]
        assert ports.journal[:2] == ["nightly", "nightly"] and log.errors == []

    asyncio.run(scenario())


def test_a_queue_runs_its_workflow_once_per_message_and_hands_back_only_what_may_work_later():
    async def scenario() -> None:
        blok, ports, log = load()
        queue = memory_queue(attempts=2)
        refused: list[Refused] = []
        queues = await start_queues(blok, subscribe=queue.subscribe, on_refused=refused.append)
        assert queues.queues == ["events"]

        queue.send("events", {"sku": "book", "note": "one"})
        queue.send("events", {"sku": "sofa", "note": "two"})
        queue.send("events", {"note": "three"})
        queue.send("events", {"sku": "book", "note": "break"})
        await queue.idle()

        assert ports.journal == ["one"]
        # A message the workflow refuses is not handed over again: it would be refused again.
        # Two messages are handled at a time, so the order they finish in is not fixed.
        assert sorted((one.queue, one.id, one.error.code, one.message["note"]) for one in refused) == [
            ("events", "workflows/events@1", "invalid_input", "three"),
            ("events", "workflows/events@1", "unknown_sku", "two"),
        ]
        # A failure nobody planned for is handed over again, twice here, and then set aside.
        line = 'workflows/events@1, on a message from "events", failed with "unexpected" at shop/record@1: the journal is full'
        assert log.errors == [line, line]
        assert [(one["queue"], one["message"]) for one in queue.dead] == [("events", {"sku": "book", "note": "break"})]
        await queues.stop()

        # With nobody to tell, a refused message is written to the log and dropped.
        blok, ports, log = load()
        queue = memory_queue()
        await start_queues(blok, subscribe=queue.subscribe)
        queue.send("events", {"sku": "sofa", "note": "x"})
        await queue.idle()
        assert log.errors == [
            'workflows/events@1, on a message from "events", failed with "unknown_sku" at shop/price@1: '
            'There is no product "sofa". The message was dropped: sending it again would be refused again.'
        ]

    asyncio.run(scenario())


def test_an_agent_lists_and_calls_a_workflow_as_a_tool():
    async def scenario() -> None:
        blok, ports, log = load()
        server = blok_mcp(blok, name="shop", version="1.0.0", instructions="Prices things.")
        async with Client(server) as client:
            tools = (await client.list_tools()).tools
            assert [(tool.name, tool.description) for tool in tools] == [
                ("note", "Writes a note in the journal."),
                ("price_order", "Prices a quantity of one product, without ordering it."),
            ]
            assert tools[1].input_schema["required"] == ["sku", "qty"]
            assert tools[1].output_schema["properties"] == {"totalCents": {"type": "integer"}}

            said = await client.call_tool("price_order", {"sku": "desk", "qty": 2})
            assert (said.is_error, said.structured_content, json.loads(said.content[0].text)) == (
                False,
                {"totalCents": 36000},
                {"totalCents": 36000},
            )
            # A refusal is something the agent can read and act on.
            said = await client.call_tool("price_order", {"sku": "sofa", "qty": 1})
            assert (said.is_error, said.content[0].text) == (True, 'unknown_sku: There is no product "sofa".')
            said = await client.call_tool("price_order", {"sku": "desk"})
            assert (said.is_error, said.content[0].text) == (True, "invalid_input: The request is missing: body.qty.")
            said = await client.call_tool("nothing", {})
            assert (said.is_error, said.content[0].text) == (True, 'There is no tool called "nothing".')
            assert log.errors == []
            # What broke inside is for the log, not for the agent.
            said = await client.call_tool("note", {"note": "break"})
            assert (said.is_error, said.content[0].text) == (True, "unexpected: The tool could not complete the call.")
        assert log.errors == [
            'workflows/note@1, called as the tool "note", failed with "unexpected" at shop/record@1: the journal is full'
        ]

    asyncio.run(scenario())
