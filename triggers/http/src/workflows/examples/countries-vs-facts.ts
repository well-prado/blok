import { http, branch, eq, node, step, workflow } from "@blokjs/core";

export default workflow(
	"Movies or Countries",
	{
		version: "1.0.0",
		description:
			"Branches on a query param: with ?countries=true returns countries; otherwise returns a random cat fact.",
		trigger: http.get("/countries-vs-facts", { accept: "application/json" }),
	},
	(req) => {
		branch("filter-request", eq(req.query.countries, "true"), {
			then: () => {
				step("get-countries", node("@blokjs/api-call"), {
					url: "https://countriesnow.space/api/v0.1/countries/capital",
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
					responseType: "application/json",
				});
			},
			else: () => {
				step("get-facts", node("@blokjs/api-call"), {
					url: "https://catfact.ninja/fact",
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
					responseType: "application/json",
				});
			},
		});
	},
);
