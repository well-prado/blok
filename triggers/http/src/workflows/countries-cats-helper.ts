import { branch, workflow } from "@blokjs/helper";

export default workflow({
	name: "World Countries",
	version: "1.0.0",
	description: "Workflow description",
	trigger: {
		http: {
			method: "GET",
			path: "/countries-cats-helper",
			accept: "application/json",
		},
	},
	steps: [
		branch({
			id: "filter-request",
			when: 'ctx.request.query.countries === "true"',
			then: [
				{
					id: "get-countries",
					use: "@blokjs/api-call",
					type: "module",
					inputs: {
						url: "https://countriesnow.space/api/v0.1/countries",
						method: "GET",
						headers: {
							"Content-Type": "application/json",
						},
						responseType: "application/json",
					},
				},
			],
			else: [
				{
					id: "get-facts",
					use: "@blokjs/api-call",
					type: "module",
					inputs: {
						url: "https://catfact.ninja/fact",
						method: "GET",
						headers: {
							"Content-Type": "application/json",
						},
						responseType: "application/json",
					},
				},
			],
		}),
	],
});
