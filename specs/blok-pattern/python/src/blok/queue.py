"""Runs every workflow that has a queue trigger, once per message. The queue itself is yours:
`subscribe` is the one function that connects a broker to Blok.

    await start_queues(blok, subscribe=my_broker_subscribe)

A message is handed over at least once, as every broker does it, so the nodes it reaches must be
safe to run twice with the same message.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .kernel import BlokError, may_work_later
from .project import App
from .workflow import QueueBinding

#: Handles one message. It raises when the message should be handed over again, and returns when it is dealt with.
Handler = Callable[[Any], Awaitable[None]]
#: Connects one queue of your broker to its handler: `subscribe(queue, handle, concurrency)`.
#: May return a function that disconnects it. Either may be async.
Subscribe = Callable[[str, Handler, int | None], Any]


@dataclass(frozen=True)
class Refused:
    """A message the workflow refused for good, so that sending it again would only be refused again."""

    queue: str
    #: The workflow.
    id: str
    message: Any
    error: BlokError


class Queues:
    def __init__(self, queues: list[str], stops: list[Any]) -> None:
        self.queues = queues
        self._stops = stops

    async def stop(self) -> None:
        for stop in self._stops:
            if callable(stop):
                done = stop()
                if inspect.isawaitable(done):
                    await done


async def start_queues(
    blok: App, *, subscribe: Subscribe, on_refused: Callable[[Refused], Any] | None = None
) -> Queues:
    """`on_refused` is called with each message a workflow refuses: one that lacks a field, or one a step
    fails on with a business error. Put it where a person will see it. Left out, it is written to the log and dropped.
    """
    bindings = [binding for binding in blok.bindings if isinstance(binding, QueueBinding)]
    stops: list[Any] = []
    for binding in bindings:

        async def handle(message: Any, binding: QueueBinding = binding) -> None:
            try:
                await blok.call(binding.unit, {"body": message})
            except Exception as err:
                error = err if isinstance(err, BlokError) else BlokError("unexpected", str(err), binding.unit.id)
                said = (
                    f'{binding.unit.id}, on a message from "{binding.queue}", failed with "{error.code}" '
                    f"at {error.node}: {error.message}"
                )
                # The broker hands the message over again, which may work: this failure was not about the message.
                if may_work_later(error.code):
                    blok.log.error(said)
                    raise error from None
                if on_refused:
                    told = on_refused(Refused(queue=binding.queue, id=binding.unit.id, message=message, error=error))
                    if inspect.isawaitable(told):
                        await told
                else:
                    blok.log.error(f"{said} The message was dropped: sending it again would be refused again.")

        stop = subscribe(binding.queue, handle, binding.concurrency)
        stops.append(await stop if inspect.isawaitable(stop) else stop)
    return Queues([binding.queue for binding in bindings], stops)


@dataclass
class _Reader:
    handle: Handler
    limit: int
    busy: int = 0


@dataclass
class MemoryQueue:
    """A queue that lives in this process, for development and for tests. It gives the app a queue to run on
    until a real one exists, as the in-memory ports do. Nothing in it survives a restart."""

    attempts: int = 3
    #: Messages that failed on every attempt. A real broker would move them to a dead-letter queue.
    dead: list[dict[str, Any]] = field(default_factory=list)
    _waiting: dict[str, list[Any]] = field(default_factory=dict)
    _readers: dict[str, _Reader] = field(default_factory=dict)
    _going: set[asyncio.Task[None]] = field(default_factory=set)

    def send(self, queue: str, message: Any) -> None:
        """Puts a message on a queue. It waits there until something subscribes."""
        self._waiting.setdefault(queue, []).append(copy.deepcopy(message))
        # Not now: whoever sent it finishes first, as with a real queue.
        asyncio.get_running_loop().call_soon(self._pump, queue)

    def subscribe(self, queue: str, handle: Handler, concurrency: int | None = None) -> Callable[[], None]:
        self._readers[queue] = _Reader(handle=handle, limit=concurrency or 1)
        self._pump(queue)
        return lambda: void(self._readers.pop(queue, None))

    def _pump(self, queue: str) -> None:
        reader = self._readers.get(queue)
        messages = self._waiting.get(queue) or []
        while reader and reader.busy < reader.limit and messages:
            message = messages.pop(0)
            reader.busy += 1
            one = asyncio.ensure_future(self._deliver(queue, reader, message))
            self._going.add(one)
            one.add_done_callback(self._going.discard)

    async def _deliver(self, queue: str, reader: _Reader, message: Any) -> None:
        attempt = 0
        while True:
            attempt += 1
            try:
                await reader.handle(message)
                break
            except Exception as error:
                if attempt < self.attempts:
                    continue
                self.dead.append({"queue": queue, "message": message, "error": error})
                break
        reader.busy -= 1
        self._pump(queue)

    async def idle(self) -> None:
        """Returns when every message that has a subscriber has been handled."""
        while True:
            await asyncio.sleep(0)
            if self._going:
                await asyncio.gather(*list(self._going), return_exceptions=True)
                continue
            if not any(left and queue in self._readers for queue, left in self._waiting.items()):
                return


def void(_value: Any) -> None:
    return None


def memory_queue(*, attempts: int = 3) -> MemoryQueue:
    return MemoryQueue(attempts=attempts)
