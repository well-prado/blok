import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"countries.listRoot",
	{
		version: "1.0.0",
		description: "Returns a list of world countries from the public CountriesNow API.",
		trigger: http.get("/countries", { accept: "application/json" }),
	},
	() => {
		step("get-countries-api", node("@blokjs/api-call"), {
			url: "https://countriesnow.space/api/v0.1/countries/capital",
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
			responseType: "application/json",
		});
	},
);
