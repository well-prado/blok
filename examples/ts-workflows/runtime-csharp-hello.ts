import { workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the C# sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the C# runtime
 * (`blokctl create … --runtimes csharp`, or `blokctl runtime add csharp` later).
 * On `blokctl dev` the C# SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 * Two data paths in one call — this is the point of the example:
 *   - `name`   comes from the request BODY (the node reads `ctx.request.body.name`)
 *   - `prefix` comes from the step `inputs` (step inputs become the node's config)
 *
 *   POST /runtimes/csharp/hello   { "name": "Ada" }
 *   → { "message": "Hello from the C# runtime, Ada!", "timestamp": "…", "language": "csharp" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-csharp-hello",
	version: "1.0.0",
	description: "Calls the C# runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/csharp/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.csharp",
			// Step inputs become the node's config. The hello-world node reads
			// `prefix` from there; `name` flows in separately from the request body.
			inputs: { prefix: "Hello from the C# runtime" },
		},
	],
});
