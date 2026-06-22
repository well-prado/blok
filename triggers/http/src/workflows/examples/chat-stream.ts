import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Chat Stream",
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
	steps: [
		{
			id: "sub",
			use: "@blokjs/sse-subscribe",
			type: "module",
			inputs: {
				channels: ["chat:{sessionId}"],
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
