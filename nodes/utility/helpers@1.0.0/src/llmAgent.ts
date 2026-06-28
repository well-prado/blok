import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.6.10 — agentic chat with OpenAI-style tool calling.
 *
 * Like `@blokjs/llm-stream` but with a TOOL LOOP. Each iteration:
 *
 *   1. Stream a chat completion from the OpenAI-compatible endpoint.
 *      Token deltas publish to `<channel>` as `<chunkEvent>` events.
 *   2. If the model finished with `finish_reason: "tool_calls"`, dispatch
 *      each requested tool via plain HTTP POST to its declared `endpoint`.
 *      The tool's response body lands in the conversation as a `tool`
 *      role message, and the loop repeats.
 *   3. If the model finished with `finish_reason: "stop"`, the loop ends
 *      and the node returns the accumulated text.
 *
 * Tool handlers are HTTP endpoints (any URL) — keeps the agent transport-
 * agnostic. Inside a Blok project you'll usually point tools at a sibling
 * HTTP workflow (e.g. `http://localhost:4000/tools/weather`). The body
 * sent to each tool is `{ args: <model-parsed-arguments> }`; the response
 * body (parsed as JSON when possible, else raw text) is what the model
 * sees on the next turn.
 *
 * Bus events:
 *   - `<chunkEvent>` (default "token"): `{ delta }` per streamed text chunk.
 *   - `tool_call`: `{ name, args, iteration }` when the model requests a tool.
 *   - `tool_result`: `{ name, ok, status, body, iteration }` after the tool runs.
 *   - `<doneEvent>` (default "done"): `{ fullText, finishReason, iterations, toolCalls }`.
 *
 * Hard cap at `maxIterations` (default 10) to bound runaway loops. If the
 * cap is hit while the model is still requesting tools, the node throws —
 * authors should either raise the cap or trim the conversation.
 *
 * Reuses `@blokjs/llm-stream`'s lazy-import pattern for `openai` + the SSE
 * trigger bus singleton, so workflows that don't invoke this node don't
 * pull in either dependency.
 */
export default defineNode({
	name: "@blokjs/llm-agent",
	description:
		"Agentic chat loop with HTTP-dispatched tool calls. Streams tokens, tool calls, and tool results to the SSE bus.",
	input: z.object({
		channel: z
			.string()
			.min(1)
			.describe("SSE bus channel to publish chunks + tool events on. Typically `agent:<sessionId>` per-conversation."),
		apiKey: z.string().min(1).describe("API key for the upstream provider."),
		model: z.string().min(1).describe("Model identifier (e.g. `openai/gpt-4o-mini` on OpenRouter)."),
		messages: z
			.array(
				z.object({
					role: z.enum(["system", "user", "assistant", "tool"]),
					content: z.string(),
					tool_call_id: z.string().optional(),
					name: z.string().optional(),
				}),
			)
			.min(1)
			.describe("OpenAI-format chat messages including any prior tool messages."),
		tools: z
			.array(
				z.object({
					name: z.string().min(1).describe("Tool name surfaced to the model."),
					description: z.string().describe("What the tool does — model uses this to decide when to call."),
					parameters: z
						.unknown()
						.describe("JSON Schema for the tool arguments. Surfaced verbatim to the OpenAI tools array."),
					endpoint: z.string().url().describe("URL the agent POSTs to when the model picks this tool."),
					method: z.string().default("POST").describe("HTTP method for the tool dispatch."),
					headers: z
						.record(z.string())
						.optional()
						.describe("Optional extra headers for the tool dispatch (auth tokens, etc.)."),
				}),
			)
			.default([])
			.describe("Tools the model may call. Empty array = plain chat (same as llm-stream)."),
		baseUrl: z.string().url().default("https://openrouter.ai/api/v1").describe("OpenAI-compatible base URL."),
		chunkEvent: z.string().default("token").describe("SSE event name for streamed token chunks."),
		doneEvent: z.string().default("done").describe("SSE event name for the final completion frame."),
		maxIterations: z
			.number()
			.int()
			.positive()
			.max(50)
			.default(10)
			.describe("Cap on tool-call rounds to bound runaway loops. Default 10."),
		temperature: z.number().min(0).max(2).optional(),
		maxTokens: z.number().int().positive().optional(),
	}),
	output: z.object({
		fullText: z.string(),
		finishReason: z.string().optional(),
		iterations: z.number().int().positive(),
		channel: z.string(),
		toolCalls: z.array(
			z.object({
				name: z.string(),
				args: z.unknown(),
				result: z.unknown(),
				ok: z.boolean(),
			}),
		),
	}),
	async execute(_ctx, input) {
		interface SsePublishedEvent {
			channel: string;
			id: string;
		}
		interface SseBusModule {
			_getSSEBus(): {
				publish(channel: string, opts: { event?: string; data: unknown }): SsePublishedEvent;
			};
		}
		let bus: ReturnType<SseBusModule["_getSSEBus"]>;
		try {
			const mod = (await import("@blokjs/trigger-sse")) as SseBusModule;
			bus = mod._getSSEBus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/llm-agent: cannot load @blokjs/trigger-sse (${msg}). Install it as a dependency of the workflow's runtime.`,
			);
		}

		interface OpenAIToolCallDelta {
			index?: number;
			id?: string;
			type?: string;
			function?: { name?: string; arguments?: string };
		}
		interface OpenAIChunkChoice {
			delta?: { content?: string; tool_calls?: OpenAIToolCallDelta[] };
			finish_reason?: string | null;
		}
		interface OpenAIStreamChunk {
			choices?: OpenAIChunkChoice[];
		}
		interface OpenAIClientCtor {
			new (config: { apiKey: string; baseURL?: string }): {
				chat: {
					completions: {
						create(args: Record<string, unknown>): Promise<AsyncIterable<OpenAIStreamChunk>>;
					};
				};
			};
		}
		let OpenAI: OpenAIClientCtor;
		try {
			const mod = (await import("openai")) as unknown as { default: OpenAIClientCtor };
			OpenAI = mod.default;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/llm-agent: cannot load 'openai' SDK (${msg}). Install it as a project dep: \`bun add openai\`.`,
			);
		}

		const client = new OpenAI({ apiKey: input.apiKey, baseURL: input.baseUrl });

		// OpenAI tools array — emitted on every iteration so the model sees them.
		const toolsArray =
			input.tools.length > 0
				? input.tools.map((t) => ({
						type: "function" as const,
						function: { name: t.name, description: t.description, parameters: t.parameters },
					}))
				: undefined;
		const toolMap = new Map(input.tools.map((t) => [t.name, t]));

		// Running conversation across iterations. We mutate this with assistant
		// tool-call messages + tool-result messages so the next iteration sees
		// the loop history.
		interface AgentMessage {
			role: "system" | "user" | "assistant" | "tool";
			content: string | null;
			tool_call_id?: string;
			name?: string;
			tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
		}
		const conversation: AgentMessage[] = input.messages.map((m) => ({
			role: m.role,
			content: m.content,
			tool_call_id: m.tool_call_id,
			name: m.name,
		}));

		const allToolCalls: { name: string; args: unknown; result: unknown; ok: boolean }[] = [];
		let fullText = "";
		let finishReason: string | undefined;
		let iteration = 0;

		while (iteration < input.maxIterations) {
			iteration += 1;
			const stream = await client.chat.completions.create({
				model: input.model,
				messages: conversation,
				stream: true,
				...(toolsArray !== undefined ? { tools: toolsArray, tool_choice: "auto" } : {}),
				...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
				...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
			});

			// Accumulators for this iteration.
			let iterText = "";
			const toolCallBuilders = new Map<number, { id?: string; name?: string; argsRaw: string }>();
			let iterFinishReason: string | undefined;

			for await (const chunk of stream) {
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta?.content;
				if (typeof delta === "string" && delta.length > 0) {
					iterText += delta;
					fullText += delta;
					bus.publish(input.channel, { event: input.chunkEvent, data: { delta } });
				}
				if (Array.isArray(choice.delta?.tool_calls)) {
					for (const tcDelta of choice.delta.tool_calls) {
						if (typeof tcDelta.index !== "number") continue;
						const existing = toolCallBuilders.get(tcDelta.index) ?? { argsRaw: "" };
						if (tcDelta.id !== undefined) existing.id = tcDelta.id;
						if (tcDelta.function?.name !== undefined) existing.name = tcDelta.function.name;
						if (tcDelta.function?.arguments !== undefined) existing.argsRaw += tcDelta.function.arguments;
						toolCallBuilders.set(tcDelta.index, existing);
					}
				}
				if (typeof choice.finish_reason === "string") iterFinishReason = choice.finish_reason;
			}

			finishReason = iterFinishReason;

			// No tool calls → terminal turn. Loop exits with the assistant's
			// final text in fullText.
			if (toolCallBuilders.size === 0) {
				break;
			}

			// Persist the assistant's tool-call message into the conversation
			// so the upcoming tool-role responses link back to it correctly.
			const assistantToolCalls: NonNullable<AgentMessage["tool_calls"]> = [];
			for (const [, built] of toolCallBuilders) {
				if (built.id !== undefined && built.name !== undefined) {
					assistantToolCalls.push({
						id: built.id,
						type: "function",
						function: { name: built.name, arguments: built.argsRaw },
					});
				}
			}
			conversation.push({
				role: "assistant",
				content: iterText.length > 0 ? iterText : null,
				tool_calls: assistantToolCalls,
			});

			// Dispatch each tool sequentially. Sequential is fine for the demo
			// shape (a couple of tools per turn); for high-fanout agents a
			// future iteration can parallelize. Errors from a single tool
			// surface as ok:false back to the model — never crash the loop.
			for (const tc of assistantToolCalls) {
				const def = toolMap.get(tc.function.name);
				let parsedArgs: unknown;
				try {
					parsedArgs = JSON.parse(tc.function.arguments);
				} catch {
					parsedArgs = tc.function.arguments;
				}

				bus.publish(input.channel, {
					event: "tool_call",
					data: { name: tc.function.name, args: parsedArgs, iteration },
				});

				let toolResult: unknown;
				let ok = true;
				let status = 0;
				if (!def) {
					toolResult = { error: `Unknown tool: ${tc.function.name}` };
					ok = false;
				} else {
					try {
						const res = await fetch(def.endpoint, {
							method: def.method ?? "POST",
							headers: { "Content-Type": "application/json", ...(def.headers ?? {}) },
							body: JSON.stringify({ args: parsedArgs }),
						});
						status = res.status;
						const text = await res.text();
						try {
							toolResult = JSON.parse(text);
						} catch {
							toolResult = text;
						}
						ok = res.ok;
					} catch (err) {
						toolResult = { error: err instanceof Error ? err.message : String(err) };
						ok = false;
					}
				}

				bus.publish(input.channel, {
					event: "tool_result",
					data: { name: tc.function.name, ok, status, body: toolResult, iteration },
				});

				allToolCalls.push({
					name: tc.function.name,
					args: parsedArgs,
					result: toolResult,
					ok,
				});

				conversation.push({
					role: "tool",
					tool_call_id: tc.id,
					name: tc.function.name,
					content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
				});
			}

			// Loop back — let the model react to tool results.
		}

		if (iteration >= input.maxIterations && finishReason !== "stop") {
			bus.publish(input.channel, {
				event: input.doneEvent,
				data: { fullText, finishReason, iterations: iteration, toolCalls: allToolCalls, capped: true },
			});
			throw new Error(
				`@blokjs/llm-agent: hit maxIterations=${input.maxIterations} while the model was still requesting tools. Raise maxIterations or trim the conversation.`,
			);
		}

		bus.publish(input.channel, {
			event: input.doneEvent,
			data: { fullText, finishReason, iterations: iteration, toolCalls: allToolCalls },
		});

		return {
			fullText,
			finishReason,
			iterations: iteration,
			channel: input.channel,
			toolCalls: allToolCalls,
		};
	},
});
