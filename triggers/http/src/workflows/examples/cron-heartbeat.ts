import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Cron Heartbeat",
	version: "1.0.0",
	description:
		"Runs on a schedule (every 5 minutes) — NOT on an HTTP request. Example of the `cron` trigger: nothing calls this; the schedule fires it. ctx.request.body is {}; fire metadata is on ctx.request.params.{schedule,firedAt}.",
	trigger: {
		cron: { schedule: "*/5 * * * *", timezone: "UTC" },
	},
	steps: [
		{
			id: "heartbeat",
			use: "@blokjs/api-call",
			inputs: { url: "https://httpbin.org/get", method: "GET" },
		},
	],
});
