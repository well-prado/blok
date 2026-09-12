import { workflow } from "@blokjs/helper";

/** Cross-runtime example — invokes the Swift sidecar. */
export default workflow({
	name: "runtime-swift-hello",
	version: "1.0.0",
	description: "Calls the Swift runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/swift/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.swift",
			inputs: { prefix: "Hello from the Swift runtime" },
		},
	],
});
