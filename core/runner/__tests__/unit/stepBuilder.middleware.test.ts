/**
 * #725 — factory-level proof that the callback `workflow(name, opts, cb)` DSL
 * (`stepBuilder.ts`) carries the workflow-level middleware CHAIN
 * (`middleware: string[]`) onto `_config`/`toJson()`, mirroring the object
 * factory's coverage in `core/workflow-helper/tests/workflowV2.test.ts`
 * (#712/PR #724). See `TriggerBase.middleware-chain-ts-callback.test.ts` for
 * the full round-trip into `normalizeWorkflow`/`TriggerBase`.
 */

import { describe, expect, it } from "vitest";
import { node } from "../../src/handles";
import { step, workflowCallback as workflow } from "../../src/stepBuilder";

const noop = () => {
	step("noop", node("@blokjs/expr"), { expression: "true" });
};

describe("workflow() callback DSL — middleware CHAIN authoring (#725)", () => {
	it("typechecks and carries `middleware: string[]` onto `_config`", async () => {
		const wf = await workflow(
			"protected",
			{
				version: "1.0.0",
				middleware: ["auth-check", "rate-limit"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			noop,
		);
		expect((wf._config as { middleware?: unknown }).middleware).toEqual(["auth-check", "rate-limit"]);
	});

	it("emits the array from toJson()", async () => {
		const wf = await workflow(
			"protected",
			{
				version: "1.0.0",
				middleware: ["auth-check"],
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			noop,
		);
		expect(JSON.parse(wf.toJson()).middleware).toEqual(["auth-check"]);
	});

	it("accepts a `readonly string[]` (e.g. `as const`) without a cast", async () => {
		const chain = ["auth-check", "rate-limit"] as const;
		const wf = await workflow(
			"protected",
			{
				version: "1.0.0",
				middleware: chain,
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			noop,
		);
		expect((wf._config as { middleware?: unknown }).middleware).toEqual(["auth-check", "rate-limit"]);
	});

	it("copies the array — mutating the caller's array after the call does not affect `_config`", async () => {
		const chain = ["auth-check"];
		const wf = await workflow(
			"protected",
			{
				version: "1.0.0",
				middleware: chain,
				trigger: { http: { method: "POST", path: "/orders" } },
			},
			noop,
		);
		chain.push("rate-limit");
		expect((wf._config as { middleware?: unknown }).middleware).toEqual(["auth-check"]);
	});

	it("a chain is still required to declare a trigger (only `middleware: true` may omit one)", async () => {
		await expect(
			workflow(
				"protected",
				{
					version: "1.0.0",
					middleware: ["auth-check"],
				},
				noop,
			),
		).rejects.toThrow(/requires a trigger/);
	});

	it("`middleware: true` (the is-middleware marker) still needs no trigger and stays a marker", async () => {
		const wf = await workflow(
			"auth-check",
			{
				version: "1.0.0",
				middleware: true,
			},
			noop,
		);
		expect((wf._config as { middleware?: unknown }).middleware).toBe(true);
	});
});
