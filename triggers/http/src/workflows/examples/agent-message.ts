import { http, type Handle, js, node, step, tpl, workflow } from "@blokjs/core";

export default workflow(
	"Agent Message",
	{
		version: "1.0.0",
		description:
			"v0.6.10 — POST handler for the agentic chat. Loads prior conversation from Redis, runs the OpenAI tool-calling loop via @blokjs/llm-agent with two demo tools (weather + calculator), persists the new turn back to Redis with a 24h TTL. The agent loop streams `token`, `tool_call`, and `tool_result` events to the SSE bus channel `agent:<sid>`; the agent-stream workflow fans them out to the browser. Set OPENROUTER_API_KEY and have Redis reachable at REDIS_URL before exercising. Tool endpoints assume the deployment is reachable at http://localhost:4000 — change to a public URL or BLOK_SELF_BASE_URL interpolation when deploying.",
		trigger: http.post("/agent/:sessionId/message", {
			accept: "application/json",
		}),
	},
	(req) => {
		const body = req.body as Handle<{ message: string }>;
		const loadHistory = step("load-history", node("@blokjs/redis-kv"), {
			action: "get",
			key: tpl`agent:${req.params.sessionId}:history`,
		});
		const agent = step("agent", node<{ fullText: string }>("@blokjs/llm-agent"), {
			channel: tpl`agent:${req.params.sessionId}`,
			apiKey: js`process.env.OPENROUTER_API_KEY`,
			model: js`process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'`,
			messages: js`[{ role: 'system', content: 'You are a helpful agent with two tools: get_weather(city) returns current weather; calculate(expression) evaluates arithmetic. Use them when the user asks weather or math questions. Be concise.' }, ...(${loadHistory}?.value || []), { role: 'user', content: ${body.message} }]`,
			tools: [
				{
					name: "get_weather",
					description: "Returns the current weather for a given city.",
					parameters: {
						type: "object",
						properties: {
							city: {
								type: "string",
								description: "City name, e.g. 'San Francisco'",
							},
						},
						required: ["city"],
					},
					endpoint: "http://localhost:4000/tools/weather",
				},
				{
					name: "calculate",
					description: "Evaluates a JavaScript arithmetic expression and returns the numeric result.",
					parameters: {
						type: "object",
						properties: {
							expression: {
								type: "string",
								description: "Arithmetic expression, e.g. '17 * 23' or '(120 + 45) / 3'",
							},
						},
						required: ["expression"],
					},
					endpoint: "http://localhost:4000/tools/calculator",
				},
			],
			maxIterations: 10,
		});
		step(
			"save-history",
			node("@blokjs/redis-kv"),
			{
				action: "set",
				key: tpl`agent:${req.params.sessionId}:history`,
				value: js`[...(${loadHistory}?.value || []), { role: 'user', content: ${body.message} }, { role: 'assistant', content: ${agent.fullText} }]`,
				ttlMs: 86400000,
			},
			{ ephemeral: true },
		);
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ ok: true, fullText: ctx.state.agent.fullText, finishReason: ctx.state.agent.finishReason, iterations: ctx.state.agent.iterations, toolCalls: ctx.state.agent.toolCalls })",
		});
	},
);
