/**
 * #725 — the callback typed-handle `workflow(name, opts, cb)` DSL
 * (`@blokjs/core`, backed by `stepBuilder.ts`) must also be able to declare
 * the v0.5.2 workflow-level middleware CHAIN, not just leave it unreachable
 * to the mandated authoring surface. #712/PR #724 fixed the LEGACY object-form
 * `workflow({...})` factory (`@blokjs/helper`) — this proves the callback DSL
 * gets the same behaviour.
 *
 * Investigation: `workflowCallback`'s `Opts` generic is
 * `Omit<WorkflowOpts<I,O,E>, "name" | "steps">`, where `WorkflowOpts` (aliased
 * `WorkflowV2Opts`) is the SAME interface #724 widened to
 * `true | readonly string[]` — so the type surface already inherited the
 * widening. And at runtime `workflowCallback` builds its envelope by
 * spreading `...opts` straight into the (already-fixed) object-style
 * `workflow()` factory (see the `objectWorkflow({...opts, name, steps})` call
 * at the bottom of `stepBuilder.ts`) — so an author-supplied `middleware`
 * already rides along untouched. No `stepBuilder.ts` code change was needed;
 * this file is the round-trip proof the issue asked for, verifying the
 * callback DSL's `opts.middleware` reaches `_config`/`toJson()` and, same as
 * the factory twin, `normalizeWorkflow` → `appliedMiddleware` →
 * `TriggerBase.applyMiddlewareChain`.
 *
 * Mirrors `TriggerBase.middleware-chain-ts-factory.test.ts` (#712) — same
 * `TestTrigger` sub-classing pattern, same assertions, swapping the object
 * factory for the callback DSL's `step()`-collecting `workflow()`.
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import { node } from "../../src/handles";
import { step, workflowCallback as workflow } from "../../src/stepBuilder";
import type GlobalOptions from "../../src/types/GlobalOptions";
import { normalizeWorkflow } from "../../src/workflow/WorkflowNormalizer";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

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

describe("workflow() middleware CHAIN — TS callback DSL round-trip (#725)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
	});

	it("carries `middleware: string[]` onto `_config` and `toJson()`", async () => {
		const wf = await workflow(
			"protected-endpoint",
			{
				version: "1.0.0",
				middleware: ["auth-check", "rate-limit"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		expect((wf._config as { middleware?: unknown }).middleware).toEqual(["auth-check", "rate-limit"]);
		expect(JSON.parse(wf.toJson()).middleware).toEqual(["auth-check", "rate-limit"]);
	});

	it("round-trips toJson() -> normalizeWorkflow() -> appliedMiddleware", async () => {
		const wf = await workflow(
			"protected-endpoint",
			{
				version: "1.0.0",
				middleware: ["auth-check", "rate-limit"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		const wire = JSON.parse(wf.toJson());
		const normalized = normalizeWorkflow(wire, "protected-endpoint.ts");
		expect(normalized.appliedMiddleware).toEqual(["auth-check", "rate-limit"]);
		expect(normalized.middleware).toBeUndefined();
	});

	it("normalizeWorkflow() also unwraps the builder envelope directly (no toJson round-trip needed)", async () => {
		const wf = await workflow(
			"protected-endpoint",
			{
				version: "1.0.0",
				middleware: ["auth-check"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		const normalized = normalizeWorkflow(wf, "protected-endpoint.ts");
		expect(normalized.appliedMiddleware).toEqual(["auth-check"]);
	});

	it("the resulting appliedMiddleware reaches TriggerBase.applyMiddlewareChain's dispatcher", async () => {
		const wf = await workflow(
			"protected-endpoint",
			{
				version: "1.0.0",
				middleware: ["auth-check"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "protected-endpoint.ts");

		const t = new TestTrigger();
		t.useNormalized(normalized);
		await t.invoke(stubCtx(), stubNodeMap());

		expect(t.captured?.names).toEqual(["auth-check"]);
	});

	it("merges workflow-level (from the TS callback DSL) BEFORE process-global middleware — outer to inner", async () => {
		WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id"]);
		const wf = await workflow(
			"protected-endpoint",
			{
				version: "1.0.0",
				middleware: ["auth-check"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "protected-endpoint.ts");

		const t = new TestTrigger();
		t.useNormalized(normalized);
		await t.invoke(stubCtx(), stubNodeMap());

		expect(t.captured?.names).toEqual(["request-id", "auth-check"]);
	});

	it("`middleware: true` (the is-middleware marker) is unchanged — still a marker, never a chain", async () => {
		const wf = await workflow(
			"auth-check",
			{
				version: "1.0.0",
				middleware: true,
			},
			() => {
				step("noop", node("@blokjs/expr"), { expression: "true" });
			},
		);
		expect((wf._config as { middleware?: unknown }).middleware).toBe(true);

		const normalized = normalizeWorkflow(JSON.parse(wf.toJson()), "auth-check.ts");
		expect(normalized.middleware).toBe(true);
		expect(normalized.appliedMiddleware).toBeUndefined();
	});
});
