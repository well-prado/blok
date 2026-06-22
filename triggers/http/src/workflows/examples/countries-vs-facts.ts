import { branch, workflow } from "@blokjs/helper";

export default workflow({
	name: "Movies or Countries",
	version: "1.0.0",
	description:
		"Branches on a query param: with ?countries=true returns countries; otherwise returns a random cat fact.",
	trigger: {
		http: {
			method: "GET",
			path: "/countries-vs-facts",
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
						url: "https://countriesnow.space/api/v0.1/countries/capital",
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
