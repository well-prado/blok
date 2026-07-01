import { http, branch, eq, node, step, workflow } from "@blokjs/core";

export default workflow(
	"countries.withCats",
	{
		version: "1.0.0",
		description: "Workflow description",
		trigger: http.get("/countries-cats-helper", { accept: "application/json" }),
	},
	(req) => {
		branch("filter-request", eq(req.query.countries, "true"), {
			then: () => {
				step("get-countries", node("@blokjs/api-call"), {
					url: "https://countriesnow.space/api/v0.1/countries",
					method: "GET",
					headers: { "Content-Type": "application/json" },
					responseType: "application/json",
				});
			},
			else: () => {
				step("get-facts", node("@blokjs/api-call"), {
					url: "https://catfact.ninja/fact",
					method: "GET",
					headers: { "Content-Type": "application/json" },
					responseType: "application/json",
				});
			},
		});
	},
);
