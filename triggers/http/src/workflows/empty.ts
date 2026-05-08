import { branch, workflow } from "@blokjs/helper";

export default workflow({
	name: "Empty",
	version: "1.0.0",
	description: "Workflow for load testing",
	trigger: {
		http: {
			method: "GET",
			path: "/empty-helper",
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
