import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRuntimeAliasWarningCache, normalizeWorkflow } from "../workflow/WorkflowNormalizer";

describe("JavaScript runtime step normalization", () => {
	beforeEach(() => {
		_resetRuntimeAliasWarningCache();
		vi.restoreAllMocks();
	});

	it("keeps the canonical runtime.nodejs spelling", () => {
		const normalized = normalizeWorkflow({
			name: "node-runtime",
			steps: [{ id: "run", use: "portable-node", type: "runtime.nodejs" }],
		});

		expect(normalized.steps[0].type).toBe("runtime.nodejs");
	});

	it("canonicalizes runtime.node and diagnoses the compatibility alias", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const normalized = normalizeWorkflow(
			{
				name: "legacy-node-runtime",
				steps: [{ id: "run", use: "portable-node", type: "runtime.node" }],
			},
			"legacy-node-runtime.json",
		);

		expect(normalized.steps[0].type).toBe("runtime.nodejs");
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('Runtime alias "node" is deprecated'));
	});

	it("recognizes runtime.deno without rewriting it to Node.js", () => {
		const normalized = normalizeWorkflow({
			name: "deno-runtime",
			steps: [{ id: "run", use: "portable-node", type: "runtime.deno" }],
		});

		expect(normalized.steps[0].type).toBe("runtime.deno");
	});
});
