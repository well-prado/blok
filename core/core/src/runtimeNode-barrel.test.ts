import { runtimeNode, step, workflow } from "@blokjs/core";
import { describe, expect, it } from "vitest";

/**
 * #424 regression — `runtimeNode` was re-exported TYPE-ONLY from `@blokjs/core`,
 * so the stubs `blokctl nodes sync` generate —
 *   import { runtimeNode } from "@blokjs/core";
 *   export const ask = runtimeNode<In, Out>("ask", "runtime.python3:ask");
 * — resolved `runtimeNode` to `undefined` and crashed with "runtimeNode is not a
 * function" the moment the stub module loaded. This guards the EXACT package-root
 * import path the generated stubs use.
 */
describe("@blokjs/core barrel — runtimeNode is a real value (#424)", () => {
	it("imports as a callable value from the package root, not a type-only binding", () => {
		expect(typeof runtimeNode).toBe("function");
		expect(runtimeNode("ask", "runtime.python3:ask")).toEqual({
			kind: "runtimeNode",
			name: "ask",
			runtime: "runtime.python3:ask",
		});
	});

	it("a generated stub passes through step() and lowers to a runtime step without throwing", async () => {
		// Exactly the generated-stub shape: runtimeNode(name, catalog-ref).
		const ask = runtimeNode<{ prompt: string }, { answer: string }>("ask", "runtime.python3:ask");
		const wf = await workflow("rt-barrel", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			step("call-ask", ask, {});
		});
		expect((wf as { _config: { steps: Array<Record<string, unknown>> } })._config.steps[0]).toMatchObject({
			id: "call-ask",
			use: "ask",
			type: "runtime.python3",
		});
	});
});
