/**
 * `node("<name>")` — the typed-handle counterpart of a bare `use: "<name>"`
 * string. Proves it (1) returns a `{ name }` ref, (2) rejects an empty name,
 * and (3) lowers through `step()` to a real MODULE step that the engine runs
 * (no `type` → normalizer infers "module"), landing on `ctx.state[id]`.
 */
import { defineNode } from "@blokjs/runner";
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { http, node, step, workflow } from "./index";

const echo = defineNode({
	name: "echo-node",
	description: "returns its input unchanged",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	execute: async (_ctx, input) => input,
});

describe("node() published/module reference", () => {
	it("returns a { name } ref and rejects an empty name", () => {
		expect(node("@blokjs/api-call")).toEqual({ name: "@blokjs/api-call" });
		expect(() => node("")).toThrow(/non-empty node name/);
	});

	it("lowers through step() to a module step that runs (state[id] populated)", async () => {
		const wf = await workflow("node-ref-wf", { version: "1.0.0", trigger: http.post("/nref") }, (req) => {
			// Reference the node by NAME via node() — no imported value needed.
			step("out", node("echo-node"), { v: req.body.v });
		});

		const runner = new WorkflowTestRunner();
		runner.registerNode("echo-node", echo);
		runner.loadWorkflow(wf);

		const result = await runner.execute({ v: 42 });
		expect(result.success).toBe(true);
		// The module step ran and persisted its output at state["out"].
		expect(result.state?.out).toEqual({ v: 42 });
	});
});
