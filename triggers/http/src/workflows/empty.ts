import { branch, workflow } from "@blokjs/helper";

export default workflow({
	name: "Empty",
	version: "1.0.0",
	description: "Workflow for load testing",
	trigger: {
		http: {
			method: "GET",
			// Preserve the legacy /<workflow-key>/ URL after the v2 migration.
			path: "/empty",
			accept: "application/json",
		},
	},
	steps: [
		branch({
			id: "filter-request",
			when: 'ctx.request.query.countries === "true"',
			then: [],
			else: [],
		}),
	],
});
