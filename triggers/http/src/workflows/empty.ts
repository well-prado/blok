import { AddElse, AddIf, type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
	name: "Empty",
	version: "1.0.0",
	description: "Workflow for load testing",
})
	.addTrigger("http", {
		method: "GET",
		path: "/",
		accept: "application/json",
	})
	.addCondition({
		node: {
			name: "filter-request",
			node: "@blokjs/if-else",
			type: "module",
		},
		conditions: () => {
			return [new AddIf('ctx.request.query.countries === "true"').build(), new AddElse().build()];
		},
	});

export default step;
