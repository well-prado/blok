import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Agent Stream",
	version: "1.0.0",
	description:
		"v0.6.10 — SSE subscriber for the agentic chat. Subscribes to bus channel `agent:<sessionId>` and pumps `token`, `tool_call`, `tool_result`, and `done` events to the browser. The chat-ui EventSource handles all four event names.",
	trigger: {
		sse: {
			path: "/sse/agent/:sessionId",
			heartbeatInterval: 15000,
			retryInterval: 3000,
		},
	},
	steps: [
		{
			id: "sub",
			use: "@blokjs/sse-subscribe",
			type: "module",
			inputs: {
				channels: ["agent:{sessionId}"],
			},
		},
		{
			id: "stream",
			use: "@blokjs/sse-stream",
			type: "module",
			inputs: {
				source: "js/ctx.state.sub",
			},
		},
	],
});
