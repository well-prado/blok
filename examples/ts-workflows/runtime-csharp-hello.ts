import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the C# sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the C# runtime
 * (`blokctl create … --runtimes csharp`, or `blokctl runtime add csharp` later).
 * On `blokctl dev` the C# SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/csharp/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "csharp" }
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
			inputs: { name: $.req.body.name },
		},
	],
});
