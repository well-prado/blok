import { $, workflow } from "@blokjs/helper";

/**
 * Cross-runtime example — runs the Java sidecar's built-in `hello-world` node.
 *
 * Ships only when the project is scaffolded with the Java runtime
 * (`blokctl create … --runtimes java`, or `blokctl runtime add java` later).
 * On `blokctl dev` the Java SDK container starts and registers `hello-world`;
 * this HTTP workflow dispatches to it over gRPC.
 *
 *   POST /runtimes/java/hello   { "name": "Ada" }
 *   → { "message": "Hello, Ada!", "timestamp": "…", "language": "java" }
 *
 * The single step is the terminal step, so the HTTP trigger emits its output
 * as the JSON response — no `@blokjs/respond` needed.
 */
export default workflow({
	name: "runtime-java-hello",
	version: "1.0.0",
	description: "Calls the Java runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/java/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.java",
			inputs: { name: $.req.body.name },
		},
	],
});
