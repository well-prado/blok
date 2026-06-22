import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the PHP sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the PHP runtime
 * (`blokctl create … --runtimes php`, or `blokctl runtime add php` later).
 * On `blokctl dev` the PHP SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/php/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "php" }
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
			inputs: { name: $.req.body.name },
		},
	],
});
