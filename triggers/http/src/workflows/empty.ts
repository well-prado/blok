import { AddElse, AddIf, type Step, Workflow } from "@blok/helper";

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
			node: "@blok/if-else",
			type: "module",
		},
		conditions: () => {
			return [new AddIf('ctx.request.query.countries === "true"').build(), new AddElse().build()];
		},
	});

export default step;
