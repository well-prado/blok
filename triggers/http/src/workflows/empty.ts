import { http, branch, eq, workflow } from "@blokjs/core";

export default workflow(
	"Empty",
	{
		version: "1.0.0",
		description: "Workflow for load testing",
		trigger: http.get("/empty-helper", { accept: "application/json" }),
	},
	(req) => {
		branch("filter-request", eq(req.query.countries, "true"), {
			then: () => {},
			else: () => {},
		});
	},
);
