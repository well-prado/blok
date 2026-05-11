import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * v0.7 — close the WebSocket connection that triggered the current
 * workflow run. Most commonly used inside a `connect` workflow when
 * authorization fails or invariants are violated — close the upgrade
 * cleanly with a structured close code.
 *
 * Close codes per RFC 6455:
 *   - 1000 Normal closure (default)
 *   - 1001 Going away
 *   - 1008 Policy violation
 *   - 1011 Server error
 *   - 4000-4999 Application-specific (use these for auth, rate limit, etc.)
 */
export default defineNode({
	name: "@blokjs/ws-close",
	description: "Close the WebSocket connection that triggered this workflow run.",
	input: z.object({
		code: z.number().int().min(1000).max(4999).optional().describe("WebSocket close code (default 1000)."),
		reason: z.string().max(123).optional().describe("Close reason (max 123 bytes per RFC 6455)."),
	}),
	output: z.object({
		closed: z.boolean(),
		code: z.number(),
		connectionId: z.string().optional(),
	}),
	async execute(ctx, input) {
		if (!ctx.connection) {
			throw new Error(
				"@blokjs/ws-close: ctx.connection is undefined. This step only works inside workflows triggered by `trigger.websocket`.",
			);
		}
		const code = input.code ?? 1000;
		ctx.connection.close(code, input.reason);
		return { closed: true, code, connectionId: ctx.connection.id };
	},
});
