/**
 * #712 — the TS `workflow()` factory (`@blokjs/helper`) must carry the v0.5.2
 * workflow-level middleware CHAIN (`middleware: ["auth-check"]`), not just the
 * `middleware: true` marker. Before the fix, `WorkflowOpts.middleware` was typed
 * `true` only, so TypeScript authors could not even express a chain — and the
 * one branch that DID handle it (`opts.middleware === true ? ... : {}`) dropped
 * an array silently.
 *
 * This proves the full path a real deployment exercises:
 *   `workflow({middleware: [...]})` → `_config`/`toJson()` → `normalizeWorkflow`
 *   → `appliedMiddleware` → `TriggerBase.applyMiddlewareChain` actually invokes
 *   the merged chain.
 *
 * Reuses the `TestTrigger` sub-classing pattern from
 * `TriggerBase.middleware-merge.test.ts`, which proves the merge mechanics in
 * isolation; this file proves the TS authoring surface actually reaches it.
 */

import { workflow } from "@blokjs/helper";
import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import type GlobalOptions from "../../src/types/GlobalOptions";
import { normalizeWorkflow } from "../../src/workflow/WorkflowNormalizer";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

const minimalStep = { id: "noop", use: "@blokjs/expr", inputs: { expression: "true" } } as const;

class TestTrigger extends TriggerBase {
	public captured: { names: readonly string[] } | null = null;

	override async listen(): Promise<number> {
		return 0;
	}

	async stop(): Promise<void> {
		// no-op
	}

	protected override async runMiddlewareChain(
		_ctx: Context,
		names: readonly string[],
		_nodeMap: GlobalOptions,
	): Promise<void> {
		this.captured = { names };
	}

	async invoke(ctx: Context, nodeMap: GlobalOptions): Promise<void> {
		await this.applyMiddlewareChain(ctx, nodeMap);
	}

	/** Stamp `this.configuration.appliedMiddleware` from a normalized workflow. */
	useNormalized(normalized: { appliedMiddleware?: readonly string[] }): void {
		(this.configuration as unknown as { appliedMiddleware: readonly string[] }).appliedMiddleware =
			normalized.appliedMiddleware ?? [];
	}
}

const stubCtx = (): Context =>
	({
		id: "test",
		workflow_name: "test-wf",
		request: { headers: {}, body: {}, query: {}, params: {} },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		vars: {},
		env: {},
	}) as unknown as Context;

const stubNodeMap = (): GlobalOptions => ({}) as unknown as GlobalOptions;

describe("workflow() middleware CHAIN — TS factory round-trip (#712)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
	});

	it("carries `middleware: string[]` onto `_config` and `toJson()`", () => {
		const wf = workflow({
			name: "protected-endpoint",
			version: "1.0.0",
			middleware: ["auth-check", "rate-limit"],
			trigger: { http: { method: "POST", path: "/orders" } },
			steps: [minimalStep],
		});
		expect((wf._config as { middleware?: unknown }).middleware).toEqual(["auth-check", "rate-limit"]);
		expect(JSON.parse(wf.toJson()).middleware).toEqual(["auth-check", "rate-limit"]);
	});

	it("round-trips toJson() -> normalizeWorkflow() -> appliedMiddleware", () => {
		const wf = workflow({
			name: "protected-endpoint",
			version: "1.0.0",
			middleware: ["auth-check", "rate-limit"],
			trigger: { http: { method: "POST", path: "/orders" } },
			steps: [minimalStep],
		});
		const wire = JSON.parse(wf.toJson());
		const normalized = normalizeWorkflow(wire, "protected-endpoint.ts");
		expect(normalized.appliedMiddleware).toEqual(["auth-check", "rate-limit"]);
		expect(normalized.middleware).toBeUndefined();
	});

	it("normalizeWorkflow() also unwraps the builder envelope directly (no toJson round-trip needed)", () => {
		const wf = workflow({
			name: "protected-endpoint",
			version: "1.0.0",
			middleware: ["auth-check"],
			trigger: { http: { method: "POST", path: "/orders" } },
			steps: [minimalStep],
		});
		const normalized = normalizeWorkflow(wf, "protected-endpoint.ts");
		expect(normalized.appliedMiddleware).toEqual(["auth-check"]);
	});

	it("the resulting appliedMiddleware reaches TriggerBase.applyMiddlewareChain's dispatcher", async () => {
		const wf = workflow({
			name: "protected-endpoint",
			version: "1.0.0",
			middleware: ["auth-check"],
			trigger: { http: { method: "POST", path: "/orders" } },
			steps: [minimalStep],
		});
		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "protected-endpoint.ts");

		const t = new TestTrigger();
		t.useNormalized(normalized);
		await t.invoke(stubCtx(), stubNodeMap());

		expect(t.captured?.names).toEqual(["auth-check"]);
	});

	it("merges workflow-level (from the TS factory) BEFORE process-global middleware — outer to inner", async () => {
		WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id"]);
		const wf = workflow({
			name: "protected-endpoint",
			version: "1.0.0",
			middleware: ["auth-check"],
			trigger: { http: { method: "POST", path: "/orders" } },
			steps: [minimalStep],
		});
		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "protected-endpoint.ts");

		const t = new TestTrigger();
		t.useNormalized(normalized);
		await t.invoke(stubCtx(), stubNodeMap());

		expect(t.captured?.names).toEqual(["request-id", "auth-check"]);
	});

	it("`middleware: true` (the is-middleware marker) is unchanged — still a marker, never a chain", () => {
		const wf = workflow({
			name: "auth-check",
			version: "1.0.0",
			middleware: true,
			steps: [minimalStep],
		});
		expect((wf._config as { middleware?: unknown }).middleware).toBe(true);

		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "auth-check.ts");
		expect(normalized.middleware).toBe(true);
		expect(normalized.appliedMiddleware).toBeUndefined();
	});
});
