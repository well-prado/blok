import { http, js, node, step, tpl, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";

export default workflow(
	"Chat Message",
	{
		version: "1.0.0",
		description:
			"HTTP POST handler for the chat demo. Calls @blokjs/llm-stream which streams the LLM response chunk-by-chunk to the in-process SSE bus channel `chat:<sessionId>`. The companion chat-stream workflow's SSE subscriber pumps those frames to the connected browser.",
		trigger: http.post("/chat/:sessionId/message", { accept: "application/json" }),
	},
	(req) => {
		const body = req.body as Handle<{ messages: unknown[] }>;
		step("stream", node("@blokjs/llm-stream"), {
			channel: tpl`chat:${req.params.sessionId}`,
			apiKey: js`process.env.OPENROUTER_API_KEY`,
			model: js`process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'`,
			messages: body.messages,
		});
	},
);
