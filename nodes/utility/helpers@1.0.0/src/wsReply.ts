import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — send a message back to the WebSocket connection that triggered
 * the current workflow run. Reads `ctx.connection` (bound by
 * `WebSocketTrigger` per-run) and calls `ctx.connection.send(...)`.
 *
 * Use inside workflows triggered by `trigger.websocket`. On HTTP /
 * Worker / Cron workflows, `ctx.connection` is undefined and this step
 * throws.
 *
 * Payload is JSON-stringified by default; pass `raw: true` to send the
 * value as-is (must be a string or Buffer-like).
 */
export default defineNode({
	name: "@blokjs/ws-reply",
	description: "Send a message back to the WebSocket connection that triggered this run.",
	input: z.object({
		event: z
			.string()
			.optional()
			.describe(
				"Optional event name. When set, the payload is wrapped as `{ event, data: payload }` and JSON-stringified (matches the WS trigger's default frame shape).",
			),
		payload: z.unknown(),
		raw: z
			.boolean()
			.optional()
			.describe(
				"When true, send the payload as-is (skip JSON.stringify). Payload must be string | ArrayBuffer | Uint8Array.",
			),
	}),
	output: z.object({
		sent: z.boolean(),
		connectionId: z.string().optional(),
	}),
	async execute(ctx, input) {
		if (!ctx.connection) {
			throw new Error(
				"@blokjs/ws-reply: ctx.connection is undefined. This step only works inside workflows triggered by `trigger.websocket`.",
			);
		}
		let body: string | ArrayBuffer | Uint8Array;
		if (input.raw === true) {
			if (
				typeof input.payload === "string" ||
				input.payload instanceof ArrayBuffer ||
				input.payload instanceof Uint8Array
			) {
				body = input.payload;
			} else {
				throw new Error("@blokjs/ws-reply: `raw: true` requires payload to be string | ArrayBuffer | Uint8Array.");
			}
		} else if (input.event) {
			body = JSON.stringify({ event: input.event, data: input.payload });
		} else {
			body = JSON.stringify(input.payload);
		}
		// JSON.stringify(undefined) is undefined, not a string — the trigger's
		// send would then reject with a cryptic "send requires a non-empty
		// message". This happens when the step's inputs miss `payload` (e.g.
		// the pre-#650 examples passed a `message` key that isn't in the
		// schema). Fail with the actual problem instead.
		if (body === undefined) {
			throw new Error("@blokjs/ws-reply: nothing to send — set `payload` (and optionally `event`).");
		}
		ctx.connection.send(body);
		return { sent: true, connectionId: ctx.connection.id };
	},
});
