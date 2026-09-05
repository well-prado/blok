import { runtimeNode, step, workflow } from "@blokjs/core";

const hello = runtimeNode<{ prefix: string }, { message: string; timestamp: string; language: string }>(
	"hello-world",
	"runtime.kotlin",
);

export default workflow(
	"runtime-kotlin-hello",
	{ version: "1.0.0", trigger: { http: { method: "POST", path: "/runtimes/kotlin/hello" } } },
	(req) => {
		step("hello", hello, { prefix: "Hello from the Kotlin runtime" });
	},
);
