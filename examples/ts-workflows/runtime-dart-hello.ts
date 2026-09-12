import { workflow } from "@blokjs/helper";

/** Cross-runtime example — invokes the Dart sidecar. */
export default workflow({
	name: "runtime-dart-hello",
	version: "1.0.0",
	description: "Calls the Dart runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/dart/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.dart",
			inputs: { prefix: "Hello from the Dart runtime" },
		},
	],
});
