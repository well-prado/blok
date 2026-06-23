import { workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Go sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Go runtime
 * (`blokctl create … --runtimes go`, or add it later via
 * `blokctl runtime add go`). On `blokctl dev` the Go SDK container starts and
 * registers `hello-world`; this HTTP workflow dispatches to it over gRPC.
 *
 * Two data paths in one call — this is the point of the example:
 *   - `name`   comes from the request BODY (the node reads `ctx.request.body.name`)
 *   - `prefix` comes from the step `inputs` (step inputs become the node's config)
 *
 *   POST /runtimes/go/hello   { "name": "Ada" }
 *   → { "message": "Hello from the Go runtime, Ada!", "timestamp": "…", "language": "go" }
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
			// Step inputs become the node's config. The hello-world node reads
			// `prefix` from there; `name` flows in separately from the request body.
			inputs: { prefix: "Hello from the Go runtime" },
		},
	],
});
