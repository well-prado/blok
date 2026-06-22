import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Go sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Go runtime
 * (`blokctl create … --runtimes go`, or add it later via
 * `blokctl runtime add go`). On `blokctl dev` the Go SDK container starts and
 * registers `hello-world`; this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/go/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "go" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-go-hello",
	version: "1.0.0",
	description: "Calls the Go runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/go/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.go",
			inputs: { name: $.req.body.name },
		},
	],
});
