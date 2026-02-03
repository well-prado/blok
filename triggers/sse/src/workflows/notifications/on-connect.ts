import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
	name: "On SSE Connect",
	version: "1.0.0",
	description: "Handles new SSE client connections",
})
	// biome-ignore lint: SSE trigger opts not yet typed in TriggerOpts
	.addTrigger("sse", { events: ["connect"] } as any)
	.addStep({
		name: "send-welcome",
		node: "welcome-message",
		type: "module",
		inputs: {
			clientId: "js/ctx.vars._sse.clientId",
			channel: "js/ctx.vars._sse.channel",
		},
	});

export default step;
