import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — write exactly ONE SSE-framed event to the client, inline,
 * from this step's inputs. The one-shot complement to `@blokjs/sse-stream`
 * (which BLOCKS pumping a bus iterator): use `sse-emit` to punctuate a
 * pipeline with discrete control frames — `message_ids`, `workflow_start`,
 * `complete`, `error` — between ordinary steps without the
 * publish→subscribe→pump dance.
 *
 * Calls `ctx.stream.writeSSE(...)` once and returns `{ sent: true }`.
 * Use only inside SSE-triggered workflows; `ctx.stream` is undefined
 * elsewhere and this step throws (same guard as `@blokjs/sse-stream`).
 *
 * @example
 *   { id: "open", use: "@blokjs/sse-emit",
 *     inputs: { event: "workflow_start", data: { runId: "$.id" } },
 *     ephemeral: true }
 */
export default defineNode({
	name: "@blokjs/sse-emit",
	description: "Write exactly one SSE event to the client from this step's inputs (one-shot; does not block).",
	input: z.object({
		event: z.string().optional().describe("SSE event name. When set, becomes the `event:` field on the frame."),
		data: z.unknown().describe("Event payload. JSON-serialized by the trigger when not already a string."),
		id: z
			.string()
			.optional()
			.describe("Optional event id, written as the SSE `id:` field. Clients echo it as Last-Event-Id on reconnect."),
		retry: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional reconnection hint (ms), written as the SSE `retry:` field."),
	}),
	output: z.object({
		sent: z.literal(true),
	}),
	async execute(ctx, input) {
		if (!ctx.stream) {
			throw new Error(
				"@blokjs/sse-emit: ctx.stream is undefined. This step only works inside workflows triggered by `trigger.sse`.",
			);
		}
		await ctx.stream.writeSSE({
			event: input.event,
			data: input.data,
			id: input.id,
			...(typeof input.retry === "number" ? { retry: input.retry } : {}),
		});
		return { sent: true as const };
	},
});
