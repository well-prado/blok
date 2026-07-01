import { node, step, workflow } from "@blokjs/core";

/**
 * SSE stream demo — open `GET /sse/demo` from any EventSource-style
 * client and the workflow subscribes the stream to the in-process
 * bus channel `sse-demo`, pumping events out as SSE frames.
 *
 * Pair with the companion `publish-demo` HTTP workflow: `POST /v07-sse-publish`
 * with `{ "event": "<name>", "data": <payload> }` pushes an event into
 * the same channel and every connected SSE client receives it in real time.
 *
 * The stream runs until the client disconnects.
 *
 * Verify end-to-end:
 *   1. In one terminal:  curl -N http://localhost:4001/sse/demo
 *   2. In another:       curl -X POST http://localhost:4000/v07-sse-publish \
 *                            -H 'Content-Type: application/json' \
 *                            -d '{"event":"hello","data":{"msg":"world"}}'
 *   3. Watch the first terminal — `event: hello` arrives instantly.
 *
 * v0.6 reliability knobs available on `trigger.sse`:
 *   heartbeatInterval — ms between `:heartbeat\n\n` keepalive frames (default 15000)
 *   retryInterval     — ms emitted as the SSE `retry:` field (default 3000)
 *   maxConnections    — hard cap on concurrent streams per process (default 10000)
 */
export default workflow(
	"SSE Stream Demo",
	{
		version: "1.0.0",
		description: "Subscribe an SSE stream to the in-process bus channel `sse-demo` and pump events as SSE frames.",
		trigger: {
			sse: {
				path: "/sse/demo",
				heartbeatInterval: 15000,
				retryInterval: 3000,
			},
		},
	},
	() => {
		const sub = step("sub", node("@blokjs/sse-subscribe"), { channels: ["sse-demo"] });
		step("stream", node("@blokjs/sse-stream"), { source: sub, eventName: "message" });
	},
);
