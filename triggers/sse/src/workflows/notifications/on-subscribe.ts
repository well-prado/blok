import { workflow } from "@blokjs/helper";

/**
 * Example SSE workflow — fires when a client subscribes to a specific channel.
 *
 * Same context shape as on-connect (ctx.state._sse exposes clientId + channel).
 */
export default workflow({
	name: "On SSE Subscribe",
	version: "1.0.0",
	description: "Handles SSE channel subscriptions",
	trigger: {
		sse: { events: ["subscribe"] },
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
