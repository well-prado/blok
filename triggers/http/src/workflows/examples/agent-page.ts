import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Agent Page",
	version: "1.0.0",
	description:
		"v0.6.10 — Renders the agentic-chat HTML page. Same chat-ui node as /chat, parameterized for the /agent endpoint family. The agent variant streams not just text tokens but also `tool_call` and `tool_result` events via SSE — the same vanilla EventSource UI handles all three. Pair with agent-message + agent-stream + the two demo tool workflows (tools/weather, tools/calculator).",
	trigger: {
		http: {
			method: "GET",
			path: "/agent",
			accept: "text/html",
		},
	},
	steps: [
		{
			id: "render",
			use: "chat-ui",
			type: "module",
			inputs: {
				endpointBase: "/agent",
				title: "Blok Agent (tool calls)",
				persistSession: true,
				bodyMode: "message",
			},
		},
	],
});
