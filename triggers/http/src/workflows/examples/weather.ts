import type { Handle } from "@blokjs/core";
import { http, branch, eq, node, step, tpl, workflow } from "@blokjs/core";

export default workflow(
	"Mastra Weather Agent",
	{
		version: "1.0.0",
		description: "POST returns weather data via the Mastra agent; GET renders a weather UI; other methods return 405.",
		trigger: http.any("/weather", { accept: "application/json" }),
	},
	(req) => {
		const method = (req as unknown as Handle<{ method: string }>).method;
		const body = req.body as Handle<{ city: string; country: string }>;
		branch("method-router", eq(method, "POST"), {
			then: () => {
				step("weather", node("mastra-agent"), {
					name: "Weather Agent",
					instructions:
						"You are a helpful weather assistant that provides accurate weather information. Your primary function is to help users get weather details for specific locations. When responding: - Always ask for a location if none is provided, - Include relevant details like humidity, wind conditions, and precipitation, - Keep responses concise but informative. Use the weatherTool to fetch current weather data.",
					model: {
						provider: "OPEN_AI",
						name: "gpt-4o-mini",
					},
					message: tpl`Could you please provide me with the current weather details for ${body.city}, ${body.country}?`,
				});
			},
			else: () => {
				branch("ui-or-error", eq(method, "GET"), {
					then: () => {
						step("weather-ui", node("weather-ui"), {
							title: "Weather UI",
							file_path: "app/weather.jsx",
						});
					},
					else: () => {
						step("method-not-allowed", node("error"), {
							message: "Invalid HTTP method",
						});
					},
				});
			},
		});
	},
);
