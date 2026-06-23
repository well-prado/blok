import { workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Python3 sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Python3 runtime
 * (`blokctl create … --runtimes python3`, or `blokctl runtime add python3` later).
 * On `blokctl dev` the Python3 SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 * Two data paths in one call — this is the point of the example:
 *   - `name`   comes from the request BODY (the node reads `ctx.request.body.name`)
 *   - `prefix` comes from the step `inputs` (step inputs become the node's config)
 *
 *   POST /runtimes/python3/hello   { "name": "Ada" }
 *   → { "message": "Hello from the Python3 runtime, Ada!", "timestamp": "…", "language": "python3" }
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
			// Step inputs become the node's config. The hello-world node reads
			// `prefix` from there; `name` flows in separately from the request body.
			inputs: { prefix: "Hello from the Python3 runtime" },
		},
	],
});
