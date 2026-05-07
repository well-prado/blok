import { workflow } from "@blokjs/helper";

export default workflow({
	name: "World Countries",
	version: "1.0.0",
	description: "Workflow description",
	trigger: {
		http: {
			method: "GET",
			path: "/",
			accept: "application/json",
		},
	},
	steps: [
		{
			id: "get-countries-api",
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
});
