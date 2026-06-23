import { workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the PHP sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the PHP runtime
 * (`blokctl create … --runtimes php`, or `blokctl runtime add php` later).
 * On `blokctl dev` the PHP SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 * Two data paths in one call — this is the point of the example:
 *   - `name`   comes from the request BODY (the node reads `ctx.request.body.name`)
 *   - `prefix` comes from the step `inputs` (step inputs become the node's config)
 *
 *   POST /runtimes/php/hello   { "name": "Ada" }
 *   → { "message": "Hello from the PHP runtime, Ada!", "timestamp": "…", "language": "php" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-php-hello",
	version: "1.0.0",
	description: "Calls the PHP runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/php/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.php",
			// Step inputs become the node's config. The hello-world node reads
			// `prefix` from there; `name` flows in separately from the request body.
			inputs: { prefix: "Hello from the PHP runtime" },
		},
	],
});
