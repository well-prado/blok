import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — publish one event to the in-process SSE event bus. Every
 * active subscriber of the named channel receives it (via the
 * subscribers' iterators) and the trigger pumps it out as an SSE
 * frame on each open stream.
 *
 * Use this from ANY workflow (HTTP, Worker, Cron, WebSocket) — it
 * doesn't need `ctx.stream`. The trigger package is loaded lazily so
 * workflows that never publish don't pay the import cost.
 *
 * For cross-process / cross-instance fan-out, swap the in-process bus
 * for a Redis Streams / NATS JetStream backplane (out of scope for
 * v0.7 PR 3 — same code path; the trigger handles transport).
 */
export default defineNode({
	name: "@blokjs/sse-publish",
	description: "Publish one event to the in-process SSE event bus. Every subscriber on the channel receives it.",
	input: z.object({
		channel: z.string().min(1).describe("Channel name. Subscribers with matching channels receive the event."),
		event: z
			.string()
			.optional()
			.describe("Optional SSE event name. When set, becomes the `event:` field on the frame."),
		data: z.unknown().describe("Event payload. JSON-serialized by the trigger when not already a string."),
		id: z.string().optional().describe("Optional event id. Defaults to the bus's process-monotonic sequence number."),
	}),
	output: z.object({
		channel: z.string(),
		id: z.string(),
	}),
	async execute(_ctx, input) {
		// Lazy import — the publisher workflow might not be co-located
		// with the SSE trigger package (e.g. a Worker-only deployment
		// publishing events for a different process to stream). Throw
		// a clear error if the trigger isn't installed. Typed loosely
		// so this helpers package doesn't need a hard dep on the
		// trigger package.
		const moduleName = "@blokjs/trigger-sse";
		interface SsePublishedEvent {
			channel: string;
			id: string;
		}
		interface SseBusModule {
			_getSSEBus(): {
				publish(channel: string, opts: { event?: string; data: unknown; id?: string }): SsePublishedEvent;
			};
		}
		let bus: ReturnType<SseBusModule["_getSSEBus"]>;
		try {
			const mod = (await import(moduleName)) as SseBusModule;
			bus = mod._getSSEBus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`@blokjs/sse-publish: cannot load @blokjs/trigger-sse (${msg}). Install it as a dependency of the workflow's runtime.`,
			);
		}
		const evt = bus.publish(input.channel, { event: input.event, data: input.data, id: input.id });
		return { channel: evt.channel, id: evt.id };
	},
});
