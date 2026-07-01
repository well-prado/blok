import { node, step, workflow } from "@blokjs/core";

export default workflow(
	"Chat (Redis Memory) Stream",
	{
		version: "1.0.0",
		description:
			"v0.6.8 — SSE subscriber for the Redis-memory chat. Mirrors chat-stream.json but on the `chat-memory:<sessionId>` bus channel so the two chat variants run side-by-side without crosstalk. Mounts on the HTTP server's Hono app (same process as chat-memory-message).",
		trigger: {
			sse: {
				path: "/sse/chat-memory/:sessionId",
				heartbeatInterval: 15000,
				retryInterval: 3000,
			},
		},
	},
	() => {
		const sub = step("sub", node("@blokjs/sse-subscribe"), {
			channels: ["chat-memory:{sessionId}"],
		});
		step("stream", node("@blokjs/sse-stream"), {
			source: sub,
		});
	},
);
