import { step } from "@blokjs/core";

export function build() {
	step("expr", "@blokjs/expr", { expression: "ctx.request.body.value" });
	step("log", "@blokjs/log", { level: "info" });
	step("throw", "@blokjs/throw", { message: "boom" });
	step("custom", "custom-node", {});
	step("dupe", "dupe", {});
	step("missing", "missing-node", {});
}
