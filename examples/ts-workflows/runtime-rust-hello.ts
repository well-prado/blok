import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Rust sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Rust runtime
 * (`blokctl create … --runtimes rust`, or `blokctl runtime add rust` later).
 * On `blokctl dev` the Rust SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/rust/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "rust" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-rust-hello",
	version: "1.0.0",
	description: "Calls the Rust runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/rust/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.rust",
			inputs: { name: $.req.body.name },
		},
	],
});
