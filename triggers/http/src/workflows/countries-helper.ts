import { workflow } from "@blokjs/helper";

export default workflow({
	name: "World Countries",
	version: "1.0.0",
	description: "Workflow description",
	trigger: {
		http: {
			method: "GET",
			// Preserve the legacy /<workflow-key>/ URL after the v2 migration so
			// existing consumers keep working. Drop this `path` to adopt the
			// file-based default URL when ready.
			path: "/countries-helper",
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
