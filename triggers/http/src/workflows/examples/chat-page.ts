import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Chat Page",
	version: "1.0.0",
	description:
		"Renders the Blok chat demo HTML page. Pair with chat-message (HTTP POST handler) + chat-stream (SSE subscriber) to get a working LLM chat backed by the SSE bus.",
	trigger: {
		http: {
			method: "GET",
			path: "/chat",
			accept: "text/html",
		},
	},
	steps: [
		{
			id: "render",
			use: "chat-ui",
			type: "module",
			inputs: {},
		},
	],
});
