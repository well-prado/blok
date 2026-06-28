import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.6.7 — stream an LLM chat completion to the in-process SSE bus.
 *
 * Uses any OpenAI-compatible Chat Completions endpoint (OpenAI itself,
 * OpenRouter, Together, Anyscale, local Ollama / vLLM, etc.). Default
 * `baseUrl` points at OpenRouter so the same node works against
 * GPT-4o, Claude, Gemini, Llama, etc. without code changes — pick a
 * model at workflow-config time.
 *
 * For each streamed delta, publishes a bus event on `channel`:
 *
 *   { event: <chunkEvent>, data: { delta: "<token text>" } }
 *
 * When the stream completes, publishes one final event:
 *
 *   { event: <doneEvent>, data: { fullText, finishReason } }
 *
 * Pair with an SSE-triggered workflow that subscribes to the same
 * channel (typically `chat:<sessionId>`) to fan tokens out to the
 * connected browser in real time. The HTML chat client's EventSource
 * listens for the chunk + done events and renders incrementally.
 *
 * Lazy-imports both `openai` (the official SDK) and the SSE trigger's
 * bus singleton, so workflows that never invoke this node don't pull
 * in either dependency. If the SDK is missing the error message
 * points the user at the install command.
 *
 * Returns the accumulated assistant message so callers can persist
 * it (e.g. into a chat-history KV store) or feed it into a
 * follow-up step.
 */
export default defineNode({
	name: "@blokjs/llm-stream",
	description:
		"Stream an OpenAI-compatible chat completion to the in-process SSE bus, publishing each delta as a bus event.",
	input: z.object({
		channel: z
			.string()
			.min(1)
			.describe("SSE bus channel to publish chunks on. Typically `chat:<sessionId>` per-conversation."),
		apiKey: z.string().min(1).describe("API key for the upstream provider. OpenRouter, OpenAI, etc."),
		model: z
			.string()
			.min(1)
			.describe('Model identifier as the provider expects it (e.g. "openai/gpt-4o-mini" on OpenRouter).'),
		messages: z
			.array(
				z.object({
					role: z.enum(["system", "user", "assistant"]),
					content: z.string(),
				}),
			)
			.min(1)
			.describe("OpenAI-format chat messages. Should include the running conversation history."),
		baseUrl: z
			.string()
			.url()
			.default("https://openrouter.ai/api/v1")
			.describe("OpenAI-compatible Chat Completions base URL. Defaults to OpenRouter."),
		chunkEvent: z.string().default("token").describe("SSE event name applied to each streamed token frame."),
		doneEvent: z.string().default("done").describe("SSE event name applied to the final completion frame."),
		temperature: z.number().min(0).max(2).optional(),
		maxTokens: z.number().int().positive().optional(),
	}),
	output: z.object({
		fullText: z.string(),
		finishReason: z.string().optional(),
		channel: z.string(),
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
		// Lazy-load the SSE bus. Without @blokjs/trigger-sse installed
		// the node can't publish anything — fail loudly with the install
		// hint rather than silently dropping tokens.
		let bus: ReturnType<SseBusModule["_getSSEBus"]>;
		try {
			const mod = (await import("@blokjs/trigger-sse")) as SseBusModule;
			bus = mod._getSSEBus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/llm-stream: cannot load @blokjs/trigger-sse (${msg}). Install it as a dependency of the workflow's runtime.`,
			);
		}

		// Lazy-load the openai SDK. Reach for the official client because
		// it implements the SSE-over-HTTP streaming protocol correctly and
		// handles auth/retry/timeout uniformly across OpenAI-compatible
		// providers. The helpers package doesn't declare a hard dep on
		// `openai` so users not running this node don't pay the install
		// cost.
		interface OpenAIChunkChoice {
			delta?: { content?: string };
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
				`@blokjs/llm-stream: cannot load 'openai' SDK (${msg}). Install it as a project dep: \`bun add openai\`.`,
			);
		}

		const client = new OpenAI({ apiKey: input.apiKey, baseURL: input.baseUrl });

		const stream = await client.chat.completions.create({
			model: input.model,
			messages: input.messages,
			stream: true,
			...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
			...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
		});

		let fullText = "";
		let finishReason: string | undefined;
		for await (const chunk of stream) {
			const choice = chunk.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta?.content;
			if (typeof delta === "string" && delta.length > 0) {
				fullText += delta;
				bus.publish(input.channel, {
					event: input.chunkEvent,
					data: { delta },
				});
			}
			if (typeof choice.finish_reason === "string") {
				finishReason = choice.finish_reason;
			}
		}

		bus.publish(input.channel, {
			event: input.doneEvent,
			data: { fullText, finishReason },
		});

		return { fullText, finishReason, channel: input.channel };
	},
});
