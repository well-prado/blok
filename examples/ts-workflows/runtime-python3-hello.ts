import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Python3 sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Python3 runtime
 * (`blokctl create … --runtimes python3`, or `blokctl runtime add python3` later).
 * On `blokctl dev` the Python3 SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/python3/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "python3" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-python3-hello",
	version: "1.0.0",
	description: "Calls the Python3 runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/python3/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.python3",
			inputs: { name: $.req.body.name },
		},
	],
});
