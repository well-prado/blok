import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — subscribe the current SSE stream to one or more channels on
 * the in-process event bus. Returns an opaque iterator handle whose
 * shape is `{ iterator }`; pass that handle as `source` to
 * `@blokjs/sse-stream` (the next step) to pump events out to the
 * client.
 *
 * Channel names support `{paramName}` placeholders that are resolved
 * against `ctx.req.params` — e.g. `"order:{orderId}"` becomes
 * `"order:42"` when the stream's GET path was `/sse/orders/42`.
 *
 * When `lastEventId` is omitted, the trigger's `ctx.stream.lastEventId`
 * (read from the `Last-Event-Id` header on reconnect) is used —
 * buffered events with `seq > lastEventId` are replayed before the
 * subscription enters the live phase. Pass an explicit string to
 * override.
 *
 * Use only inside SSE-triggered workflows. On HTTP / Worker / Cron /
 * WebSocket runs, `ctx.stream` is undefined and this step throws.
 */
export default defineNode({
	name: "@blokjs/sse-subscribe",
	description: "Subscribe the current SSE stream to channels on the in-process event bus.",
	input: z.object({
		channels: z
			.array(z.string().min(1))
			.min(1)
			.describe("Channel names. Supports `{paramName}` placeholders bound from `ctx.req.params`."),
		lastEventId: z
			.string()
			.nullish()
			.describe(
				"Replay cursor — events with `seq > lastEventId` are emitted before live events. Defaults to `ctx.stream.lastEventId`.",
			),
	}),
	output: z.object({
		iterator: z.unknown(),
		channels: z.array(z.string()),
	}),
	async execute(ctx, input) {
		if (!ctx.stream) {
			throw new Error(
				"@blokjs/sse-subscribe: ctx.stream is undefined. This step only works inside workflows triggered by `trigger.sse`.",
			);
		}
		const iterator = ctx.stream.subscribe(input.channels, input.lastEventId);
		return {
			iterator,
			channels: input.channels,
		};
	},
});
