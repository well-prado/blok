import { node, step, workflow } from "@blokjs/core";

export default workflow(
	"Chat Stream",
	{
		version: "1.0.0",
		description:
			"SSE subscriber for the chat demo. Mounts on the HTTP server's Hono app (same process as chat-message), subscribes to bus channel `chat:<sessionId>`, and pumps `token` + `done` events as SSE frames to the connected browser.",
		trigger: {
			sse: {
				path: "/sse/chat/:sessionId",
				heartbeatInterval: 15000,
				retryInterval: 3000,
			},
		},
	},
	() => {
		const sub = step("sub", node("@blokjs/sse-subscribe"), {
			channels: ["chat:{sessionId}"],
		});
		step("stream", node("@blokjs/sse-stream"), {
			source: sub,
		});
	},
);
