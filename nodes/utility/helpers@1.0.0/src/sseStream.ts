import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — pump events from an iterator (typically produced by
 * `@blokjs/sse-subscribe`) out to the client as SSE-framed messages.
 * Blocks until the iterator ends OR the client disconnects
 * (`ctx.stream.signal.aborted`).
 *
 * Each event is written via `ctx.stream.writeSSE({ event, data, id })`.
 * `event` defaults to the bus event's `event` field, falling back to
 * `eventName` from inputs. `id` defaults to the bus event's `id`
 * (process-monotonic seq), which lets clients resume cleanly via
 * `Last-Event-Id` on reconnect.
 *
 * Use only inside SSE-triggered workflows; `ctx.stream` is undefined
 * elsewhere and this step throws.
 */
export default defineNode({
	name: "@blokjs/sse-stream",
	description:
		"Pump events from an async iterator out to the SSE client until the iterator ends or the client disconnects.",
	input: z.object({
		source: z
			.unknown()
			.describe("Iterator handle — usually `$.state.<sse-subscribe step id>` returning `{ iterator }`."),
		eventName: z.string().optional().describe("Default event name applied when the bus event doesn't carry one."),
		retryMs: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("If set, emitted on the first frame as the SSE `retry:` field — clients use it on reconnect."),
		maxEvents: z.number().int().positive().optional().describe("Stop after this many events (useful for tests/demos)."),
	}),
	output: z.object({
		eventsSent: z.number(),
		endedReason: z.enum(["iterator-ended", "client-disconnected", "max-events"]),
	}),
	async execute(ctx, input) {
		if (!ctx.stream) {
			throw new Error(
				"@blokjs/sse-stream: ctx.stream is undefined. This step only works inside workflows triggered by `trigger.sse`.",
			);
		}
		const stream = ctx.stream;

		const handle = input.source as
			| { iterator?: AsyncIterableIterator<{ event?: string; data: unknown; id: string }> }
			| AsyncIterableIterator<{ event?: string; data: unknown; id: string }>
			| undefined;
		const iterator =
			handle && typeof (handle as { iterator?: unknown }).iterator !== "undefined"
				? (handle as { iterator: AsyncIterableIterator<{ event?: string; data: unknown; id: string }> }).iterator
				: (handle as AsyncIterableIterator<{ event?: string; data: unknown; id: string }> | undefined);

		if (!iterator || typeof iterator.next !== "function") {
			throw new Error(
				"@blokjs/sse-stream: `source` must be an async iterator (from `@blokjs/sse-subscribe`) or an object with an `iterator` field.",
			);
		}

		let eventsSent = 0;
		let retrySent = false;
		let endedReason: "iterator-ended" | "client-disconnected" | "max-events" = "iterator-ended";

		try {
			while (true) {
				if (stream.signal.aborted || stream.closed) {
					endedReason = "client-disconnected";
					break;
				}
				if (typeof input.maxEvents === "number" && eventsSent >= input.maxEvents) {
					endedReason = "max-events";
					break;
				}
				const next = await iterator.next();
				if (next.done) break;
				const evt = next.value;
				await stream.writeSSE({
					event: evt.event ?? input.eventName,
					data: evt.data,
					id: evt.id,
					...(retrySent || typeof input.retryMs !== "number" ? {} : { retry: input.retryMs }),
				});
				retrySent = true;
				eventsSent += 1;
			}
		} finally {
			try {
				await iterator.return?.();
			} catch {
				/* iterator already cleaned up */
			}
		}

		return { eventsSent, endedReason };
	},
});
