/**
 * v0.7 PR 3 — full end-to-end SSE trigger integration test.
 *
 * Spins up a real Hono app + `@hono/node-server` with a real
 * SSETrigger registered against the in-process event bus. Uses the
 * native `fetch` API to open a `text/event-stream` connection,
 * publishes a few events into the bus, and asserts the client
 * receives them framed correctly — proving the streamSSE pipeline,
 * `ctx.stream.subscribe()` wiring, bus delivery, and `writeSSE` frame
 * shape all work together against a real HTTP connection.
 *
 * Complements `SSETrigger.test.ts` (unit-level public surface).
 */

import type { Server } from "node:http";
import { NodeMap, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

import SSETriggerClass, { _setActiveSSETrigger } from "./SSETrigger.js";
import { _resetBusForTests, getBus } from "./bus.js";

/**
 * Wait until the SSE handler has actually subscribed to the bus.
 * Publishing before that point silently drops the events (a subscriber
 * without a lastEventId only gets live events), which used to make this
 * suite flake under parallel nx load.
 */
async function waitForSubscriber(timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getBus().stats().subscribers > 0) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`no bus subscriber after ${timeoutMs}ms — SSE handler never subscribed`);
}

/**
 * Inline "subscribe + stream" node — keeps the test independent of
 * the helper-nodes package while exercising the same `ctx.stream`
 * surface those helpers consume. Bypasses applyStepOutput like the
 * wait-inside-* fixtures do.
 */
const subscribeAndStream = defineNode({
	name: "sub-and-stream",
	description: "test fixture — subscribe to bus + pump frames out to ctx.stream",
	input: z.object({ channels: z.array(z.string()), maxEvents: z.number().int().positive() }),
	output: z.object({ sent: z.number() }),
	async execute(ctx, input) {
		if (!ctx.stream) throw new Error("no ctx.stream");
		const iterator = ctx.stream.subscribe(input.channels);
		let sent = 0;
		try {
			while (sent < input.maxEvents) {
				if (ctx.stream.signal.aborted) break;
				const next = await iterator.next();
				if (next.done) break;
				const evt = next.value;
				await ctx.stream.writeSSE({ event: evt.event ?? "msg", data: evt.data, id: evt.id });
				sent += 1;
			}
		} finally {
			await iterator.return?.();
			ctx.stream.close();
		}
		return { sent };
	},
});

describe("SSETrigger — v0.7 PR 3 integration (real HTTP/SSE)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof SSETriggerClass>;
	let httpServer: Server | null = null;

	// Ephemeral port: a hardcoded one collides with sibling trigger suites
	// that nx runs in parallel.
	const listen = (a: Hono) =>
		new Promise<number>((resolve) => {
			httpServer = serve({ fetch: a.fetch, port: 0 }, (info) => resolve(info.port)) as Server;
		});

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveSSETrigger(null);
		_resetBusForTests();
		app = new Hono();
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				if (trigger) void trigger.stop();
				_resetBusForTests();
				if (httpServer) {
					httpServer.close(() => {
						httpServer = null;
						WorkflowRegistry.resetInstance();
						_setActiveSSETrigger(null);
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveSSETrigger(null);
					resolve();
				}
			}),
	);

	it("streams bus events to a real EventSource-style client over HTTP", async () => {
		const nodes = new NodeMap();
		nodes.addNode("sub-and-stream", subscribeAndStream);

		WorkflowRegistry.getInstance().register({
			name: "live-ticks",
			source: "/test/sse-ticks.json",
			workflow: {
				name: "live-ticks",
				version: "1.0.0",
				trigger: { sse: { path: "/sse/ticks" } },
				steps: [
					{
						id: "pump",
						node: "sub-and-stream",
						type: "module",
						inputs: { channels: ["ticks"], maxEvents: 3 },
					},
				],
				nodes: { pump: { inputs: { channels: ["ticks"], maxEvents: 3 } } },
			},
		});

		trigger = new SSETriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		const port = await listen(app);

		// Publish events BEFORE the client connects so they land in the
		// channel buffer — without a lastEventId the subscriber still
		// gets only live events, so we publish after the client opens.
		const controller = new AbortController();
		const responsePromise = fetch(`http://localhost:${port}/sse/ticks`, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});

		// Wait for the server to actually mount the stream + subscribe.
		// A fixed sleep here raced the server under parallel load: events
		// published before the subscriber exists are dropped (no
		// lastEventId => live-only), and the client then waits forever.
		await waitForSubscriber();
		const bus = getBus();
		bus.publish("ticks", { event: "tick", data: { n: 1 } });
		bus.publish("ticks", { event: "tick", data: { n: 2 } });
		bus.publish("ticks", { event: "tick", data: { n: 3 } });

		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);

		// Read the stream until the server closes (after 3 events) or
		// we time out.
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			// Race the read: `reader.read()` never settles if the server
			// stops writing, so a bare await here turned any stall into an
			// opaque vitest timeout instead of this loop's deadline.
			const chunk = await Promise.race([
				reader.read(),
				new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
			]);
			if (!chunk || chunk.done) break;
			buf += decoder.decode(chunk.value, { stream: true });
			// Server closes after writing 3 frames + the initial retry; we
			// know we've got everything when the body ends.
		}
		controller.abort();

		// Parse out the data: lines.
		const dataLines = buf
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.filter((s) => s.length > 0);

		// 3 tick payloads (the initial retry frame has data: "" which
		// we filtered).
		expect(dataLines).toHaveLength(3);
		const parsed = dataLines.map((s) => JSON.parse(s) as { n: number });
		expect(parsed.map((p) => p.n)).toEqual([1, 2, 3]);
		// ponytail: no per-test timeout override — the subscriber handshake plus
		// the 5s read deadline bound this well under the config's 10s default.
		// The old 15s override only existed to paper over the publish race.
	});
});
