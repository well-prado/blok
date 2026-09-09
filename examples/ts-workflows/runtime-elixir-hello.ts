import { workflow } from "@blokjs/helper";

/** Cross-runtime example — invokes the supervised Elixir/BEAM sidecar. */
export default workflow({
	name: "runtime-elixir-hello",
	version: "1.0.0",
	description: "Calls the Elixir runtime's hello-world node over gRPC.",
	trigger: { http: { method: "POST", path: "/runtimes/elixir/hello" } },
	steps: [
		{
			id: "greet",
			use: "hello-world",
			type: "runtime.elixir",
			inputs: { prefix: "Hello from the Elixir runtime" },
		},
	],
});
