import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
// Import `runtimeNode` from the package barrel re-export (NOT the source module)
// so this also guards the #424 regression: the re-export was `export type`, so
// the value was erased and `runtimeNode(...)` threw "is not a function".
import { runtimeNode } from "../../src/index";
import { step, workflowCallback } from "../../src/stepBuilder";
import { normalizeWorkflow } from "../../src/workflow/WorkflowNormalizer";

/**
 * #424 — `runtimeNode` was exported TYPE-ONLY from `@blokjs/core`, so the stubs
 * `blokctl nodes sync` generates (`export const ask = runtimeNode(...)`) resolved
 * to `undefined` and crashed at runtime. It is now a real value, and `step()`
 * lowers it to the proven runtime-step shape so the runner routes it through the
 * gRPC runtime adapter.
 */
describe("runtimeNode (#424) — real value + step() lowering", () => {
	it("is a callable value, not a type-only erased binding", () => {
		expect(typeof runtimeNode).toBe("function");
	});

	it("returns the runtime descriptor { kind, name, runtime }", () => {
		// Exactly what `blokctl nodes sync` emits: (name, catalog-ref).
		const ask = runtimeNode<{ prompt: string }, { answer: string }>("ask", "runtime.python3:ask");
		expect(ask).toEqual({ kind: "runtimeNode", name: "ask", runtime: "runtime.python3:ask" });
	});

	it("step() lowers a generated stub to use:<name> + type:<kind> WITHOUT throwing", async () => {
		const ask = runtimeNode<{ prompt: string }, { answer: string }>("ask", "runtime.python3:ask");
		const wf = await workflowCallback("rt-wf", { version: "1.0.0", trigger: { http: { method: "POST" } } }, (req) => {
			step("call-ask", ask, { prompt: req.body.prompt });
		});
		expect(wf._config.steps[0]).toMatchObject({ id: "call-ask", use: "ask", type: "runtime.python3" });
	});

	it("normalizes to the runtime step the runner routes to the gRPC adapter (node=use, type=kind)", async () => {
		const ask = runtimeNode("ask", "runtime.python3:ask");
		const wf = await workflowCallback("rt-wf", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			step("call-ask", ask, {});
		});
		const internal = normalizeWorkflow(wf).steps[0];
		// `node` is the ref the GrpcRuntimeAdapter invokes; `type` selects the
		// runtime resolver. Both must match the proven object-DSL runtime shape.
		expect(internal.node).toBe("ask");
		expect(internal.type).toBe("runtime.python3");
	});

	it("accepts the bare-kind 2nd-arg form runtimeNode(name, 'runtime.go')", async () => {
		const fast = runtimeNode("fast", "runtime.go");
		const wf = await workflowCallback("rt-wf", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			step("call-fast", fast, {});
		});
		expect(wf._config.steps[0]).toMatchObject({ use: "fast", type: "runtime.go" });
	});

	it("leaves module (defineNode) steps unchanged — no `type` emitted, normalizer infers module", async () => {
		const echo = defineNode({
			name: "@test/echo",
			description: "module node",
			input: z.object({}).passthrough(),
			output: z.object({}).passthrough(),
			execute: (_ctx, input) => input as Record<string, unknown>,
		});
		const wf = await workflowCallback("mod", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			step("call-echo", echo, {});
		});
		expect(wf._config.steps[0].type).toBeUndefined();
		expect(normalizeWorkflow(wf).steps[0].type).toBe("module");
	});
});
