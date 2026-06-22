import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Ruby sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Ruby runtime
 * (`blokctl create … --runtimes ruby`, or `blokctl runtime add ruby` later).
 * On `blokctl dev` the Ruby SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/ruby/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "ruby" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-ruby-hello",
	version: "1.0.0",
	description: "Calls the Ruby runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/ruby/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.ruby",
			inputs: { name: $.req.body.name },
		},
	],
});
