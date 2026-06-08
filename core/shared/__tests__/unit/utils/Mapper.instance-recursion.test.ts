/**
 * Bug 1 regression — the mapper must NOT recurse into class instances.
 *
 * A resolved step config can embed framework objects with custom prototypes.
 * Most dangerously, a forEach `steps` array holds `SubworkflowNode` instances
 * whose `globalOptions.workflows` references EVERY registered workflow's
 * definition. The old `replaceObjectStrings` walked any object, so it reached
 * those foreign defs and evaluated (and mutated, in place) their `js/...`
 * expressions against the current ctx — surfacing as `Failed to resolve`
 * errors referencing an unrelated workflow's expression.
 *
 * The fix: only recurse into PLAIN objects and arrays. These tests pin both
 * halves — instances are skipped, plain containers still resolve.
 */

import { describe, expect, it, vi } from "vitest";
import type Context from "../../../src/types/Context";
import type ParamsDictionary from "../../../src/types/ParamsDictionary";
import mapper from "../../../src/utils/Mapper";

function createMockContext(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-id",
		workflow_name: "current-workflow",
		request: { body: {}, headers: {}, query: {}, params: {} },
		response: { data: null, error: null, success: true },
		error: { message: "" },
		logger: { log: vi.fn(), logLevel: vi.fn(), error: vi.fn() },
		config: {},
		func: {},
		vars: {},
		state: {},
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	} as Context;
}

/** Mimics a SubworkflowNode carrying the full workflows registry. */
class FakeSubworkflowNode {
	public name = "retrieve";
	public globalOptions = {
		workflows: {
			"foreign.auth": {
				_config: {
					name: "foreign.auth",
					// a foreign workflow's expression — must NEVER be resolved
					// against the CURRENT ctx while resolving THIS step.
					steps: [{ id: "useUid", inputs: { expression: "js/ctx.workflow_name" } }],
				},
			},
		},
	};
}

describe("Mapper — no recursion into class instances (Bug 1)", () => {
	it("does NOT resolve a js/ expression buried inside a class instance", () => {
		const node = new FakeSubworkflowNode();
		// shape mirrors a resolved forEach config: { steps: [<instance>] }
		const cfg = { in: "js/ctx.state.items", as: "item", steps: [node] } as unknown as ParamsDictionary;
		const ctx = createMockContext();

		mapper.replaceObjectStrings(cfg, ctx, {} as ParamsDictionary);

		// The foreign expression is untouched (instance not walked). Pre-fix
		// the mapper would have rewritten it to ctx.workflow_name ("current-workflow").
		const leaked = node.globalOptions.workflows["foreign.auth"]._config.steps[0].inputs.expression;
		expect(leaked).toBe("js/ctx.workflow_name");
	});

	it("STILL resolves js/ expressions in plain nested objects + arrays", () => {
		const ctx = createMockContext({ state: { items: [1, 2, 3] } } as Partial<Context>);
		const cfg = {
			nested: { value: "js/ctx.workflow_name" },
			list: ["js/ctx.state.items.length", "literal"],
		} as unknown as ParamsDictionary;

		mapper.replaceObjectStrings(cfg, ctx, {} as ParamsDictionary);

		const out = cfg as unknown as { nested: { value: unknown }; list: unknown[] };
		expect(out.nested.value).toBe("current-workflow");
		expect(out.list[0]).toBe(3);
		expect(out.list[1]).toBe("literal");
	});
});
