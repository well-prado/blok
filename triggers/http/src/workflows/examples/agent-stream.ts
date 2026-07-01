import { node, step, workflow } from "@blokjs/core";

export default workflow(
	"Agent Stream",
	{
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
	},
	() => {
		const sub = step("sub", node("@blokjs/sse-subscribe"), {
			channels: ["agent:{sessionId}"],
		});
		step("stream", node("@blokjs/sse-stream"), {
			source: sub,
		});
	},
);
