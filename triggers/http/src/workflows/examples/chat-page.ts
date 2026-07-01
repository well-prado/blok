import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"Chat Page",
	{
		version: "1.0.0",
		description:
			"Renders the Blok chat demo HTML page. Pair with chat-message (HTTP POST handler) + chat-stream (SSE subscriber) to get a working LLM chat backed by the SSE bus.",
		trigger: http.get("/chat", { accept: "text/html" }),
	},
	() => {
		step("render", node("chat-ui"), {});
	},
);
