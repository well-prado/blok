import { http, node, step, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";

/**
 * SSE publish demo — companion to `stream-demo`. Accepts an HTTP POST
 * with `{ event, data }` and publishes the event to the in-process bus
 * channel `sse-demo`. Every SSE client connected to `/sse/demo` receives
 * the event via its open stream.
 *
 * Only registers when the project has an HTTP trigger (the CLI omits
 * this file from SSE-only scaffolds). To publish from an SSE-only
 * project, swap the HTTP trigger here for a `worker` or `cron` trigger
 * — the `@blokjs/sse-publish` helper node works from any workflow kind.
 *
 * Demonstrates the in-process pub/sub model: publishers (HTTP, Cron,
 * Worker, WebSocket) and subscribers (SSE) decouple through the bus.
 *
 * Verify end-to-end:
 *   1. Open the stream:  curl -N http://localhost:4001/sse/demo
 *   2. Publish events:   curl -X POST http://localhost:4000/v07-sse-publish \
 *                            -H 'Content-Type: application/json' \
 *                            -d '{"event":"tick","data":{"count":1}}'
 *   3. The first terminal prints `event: tick\ndata: {"count":1}` instantly.
 */
export default workflow(
	"SSE Publish Demo",
	{
		version: "1.0.0",
		description: "Publish one event to the SSE bus channel `sse-demo`. Every connected `/sse/demo` client receives it.",
		trigger: http.post("/v07-sse-publish", { accept: "application/json" }),
	},
	(req) => {
		const body = req.body as Handle<{ event: string; data: unknown }>;
		step("publish", node("@blokjs/sse-publish"), {
			channel: "sse-demo",
			event: body.event,
			data: body.data,
		});
	},
);
