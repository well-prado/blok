import { step } from "@blokjs/core";

export function build() {
	step("go", "chain-test", {}, { type: "runtime.go" });
	step("rust", "chain-test", {}, { type: "runtime.rust" });
	step("java", "chain-test", {}, { type: "runtime.java" });
	step("csharp", "chain-test", {}, { type: "runtime.csharp" });
	step("python", "chain-test", {}, { type: "runtime.python3" });
}
