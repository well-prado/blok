import { http, type Handle, js, node, step, tpl, workflow } from "@blokjs/core";

export default workflow(
	"Chat (Redis Memory) Message",
	{
		version: "1.0.0",
		description:
			"v0.6.8 — POST handler for the Redis-memory chat. Loads prior conversation from Redis (key `chat-memory:<sid>:history`), prepends a system prompt, calls @blokjs/llm-stream with the full reconstructed message list, then writes the new user+assistant turns back to Redis with a 24h TTL. Demonstrates: redis-kv get/set, multi-step state composition via `js/` mapper expressions, llm-stream chained with persistence.",
		trigger: http.post("/chat-memory/:sessionId/message", {
			accept: "application/json",
		}),
	},
	(req) => {
		const body = req.body as Handle<{ message: string }>;
		const loadHistory = step("load-history", node("@blokjs/redis-kv"), {
			action: "get",
			key: tpl`chat-memory:${req.params.sessionId}:history`,
		});

		const stream = step("stream", node("@blokjs/llm-stream"), {
			channel: tpl`chat-memory:${req.params.sessionId}`,
			apiKey: js`process.env.OPENROUTER_API_KEY`,
			model: js`process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'`,
			messages: js`[{ role: 'system', content: 'You are a helpful assistant chatting with the user. The conversation may span many turns — earlier messages were stored in Redis and are included below. Be concise.' }, ...(${loadHistory}?.value || []), { role: 'user', content: ${body.message} }]`,
		});

		step(
			"save-history",
			node("@blokjs/redis-kv"),
			{
				action: "set",
				key: tpl`chat-memory:${req.params.sessionId}:history`,
				value: js`[...(${loadHistory}?.value || []), { role: 'user', content: ${body.message} }, { role: 'assistant', content: ${stream}.fullText }]`,
				ttlMs: 86400000,
			},
			{ ephemeral: true },
		);

		step("respond", node("@blokjs/expr"), {
			expression:
				"({ ok: true, fullText: ctx.state.stream.fullText, finishReason: ctx.state.stream.finishReason, turn: ((ctx.state['load-history']?.value?.length || 0) / 2) + 1 })",
		});
	},
);
