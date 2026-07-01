import { http, node, step, workflow } from "@blokjs/core";

export default workflow(
	"agent-tool-weather",
	{
		version: "1.0.0",
		description:
			"v0.6.10 — Demo tool endpoint for the agentic chat (see agent-message.json). The agent POSTs `{ args: { city: '...' } }`; we return a fake weather payload. In production this would call OpenWeatherMap / WeatherAPI / etc. Showcased pattern: an agent tool is just an HTTP endpoint — could be ANY URL, internal or external.",
		trigger: http.post("/tools/weather", { accept: "application/json" }),
	},
	() => {
		step("respond", node("@blokjs/expr"), {
			expression:
				"(() => { const city = (ctx.request.body && ctx.request.body.args && ctx.request.body.args.city) || 'unknown'; const seeded = (city.charCodeAt(0) * 31 + city.length) % 25; return { city: city, temperatureF: 50 + seeded, conditions: ['sunny','cloudy','rainy','windy'][seeded % 4], humidity: 30 + (seeded * 2) % 50 }; })()",
		});
	},
);
