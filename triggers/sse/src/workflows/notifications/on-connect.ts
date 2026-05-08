import { workflow } from "@blokjs/helper";

/**
 * Example SSE workflow — fires when a client connects to an SSE channel.
 *
 * The connection metadata is available on ctx.state._sse:
 *   - clientId: unique connection identifier
 *   - channel:  the channel the client connected to
 *
 * Inside a node, push an event back to the client via:
 *   const send = ctx.vars._sse_send as (event: string, data: unknown) => void;
 *   send("event-name", { ... });
 *
 * See `welcome-message` for a working node example.
 */
export default workflow({
	name: "On SSE Connect",
	version: "1.0.0",
	description: "Handles new SSE client connections",
	trigger: {
		sse: { events: ["connect"] },
	},
	steps: [
		{
			id: "send-welcome",
			use: "welcome-message",
			type: "module",
			inputs: {
				clientId: "js/ctx.vars._sse.clientId",
				channel: "js/ctx.vars._sse.channel",
			},
		},
	],
});
