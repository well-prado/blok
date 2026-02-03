import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
	name: "welcome-message",
	description: "Sends a welcome message to a newly connected SSE client",

	input: z.object({
		clientId: z.string(),
		channel: z.string().optional(),
	}),

	output: z.object({
		sent: z.boolean(),
		message: z.string(),
	}),

	async execute(ctx, input) {
		const send = ctx.vars?._sse_send as unknown as ((event: string, data: unknown) => void) | undefined;

		if (typeof send === "function") {
			send("welcome", {
				message: `Welcome! You are connected as ${input.clientId}`,
				channel: input.channel ?? null,
				timestamp: new Date().toISOString(),
			});
			return { sent: true, message: "Welcome message sent" };
		}

		return { sent: false, message: "SSE send function not available" };
	},
});
