import { $, branch, workflow } from "@blokjs/helper";

/**
 * WebSocket echo demo — open `ws://localhost:4000/ws/echo` (or 4002 if
 * standalone WS scaffold) and:
 *
 *   1. On `connect` the workflow sends a greeting frame
 *      `{event: "connected", payload: {ok: true}}`.
 *   2. On each subsequent message, the workflow replies with
 *      `{event: "echo", payload: {original: <whatever-you-sent>}}`.
 *
 * The handler runs once per WebSocket frame — the trigger parses the
 * client's JSON envelope, dispatches the workflow through the same
 * runner pipeline as HTTP triggers (middleware chain, ctx.connection
 * API, full Studio tracing), and routes the reply via
 * `@blokjs/ws-reply` (helper that calls `ctx.connection.send(...)`).
 *
 * Test with any WebSocket client:
 *   $ wscat -c ws://localhost:4000/ws/echo
 *   < {"event":"connected","payload":{"ok":true}}
 *   > {"event":"hello","data":{"hi":"there"}}
 *   < {"event":"echo","payload":{"original":{"event":"hello","data":{"hi":"there"}}}}
 *
 * `events: ["hello", "ping"]` in the trigger config is the event-name
 * allowlist — only frames whose `event` field matches dispatch the
 * workflow (plus the implicit `connect` / `disconnect` lifecycle
 * events). Omit the field to accept any event name.
 */
export default workflow({
	name: "WebSocket Echo Demo",
	version: "1.0.0",
	description: "Echoes received WebSocket messages back to the sender. Demonstrates the connect + message lifecycle.",
	trigger: {
		websocket: {
			path: "/ws/echo",
			events: ["hello", "ping"],
		},
	},
	steps: [
		branch({
			id: "route",
			when: "ctx.request.body.event === 'connect'",
			then: [
				{
					id: "greet",
					use: "@blokjs/ws-reply",
					inputs: { event: "connected", payload: { ok: true } },
				},
			],
			else: [
				{
					id: "echo",
					use: "@blokjs/ws-reply",
					inputs: {
						event: "echo",
						payload: { original: $.req.body },
					},
				},
			],
		}),
	],
});
