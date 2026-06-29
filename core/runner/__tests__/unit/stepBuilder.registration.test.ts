/**
 * Registration-order, arm-scoping, concurrency, and IR golden-file proof for the
 * handle-DSL builder (#422).
 *
 * The cornerstone tests (`stepBuilder.test.ts`) prove the linear `step()` chain
 * end-to-end; `branch.test.ts` / `forEach-handle.test.ts` / `switchOn-handle.test.ts`
 * / `tryCatch-handle.test.ts` prove each primitive's IR lowering + cross-arm
 * HANDLE-READ guard. This file fills the gaps #422 names that none of those cover:
 *
 *  1. GOLDEN-FILE — the SAME workflow authored two ways (callback `step()`/`branch`/
 *     `forEach` vs the object-style `workflow({steps:[...]})` + `$`/`branch`/`forEach`)
 *     compiles to STRUCTURALLY IDENTICAL `_config.steps` modulo ref encoding. The
 *     callback surface emits structural `{$ref}`; the object surface emits the
 *     `js/ctx...` wire strings directly. Running the REAL load-boundary `lowerRefs`
 *     over the callback steps collapses `{$ref}` → the same wire strings, so the two
 *     trees become byte-identical — same order, same nested arms.
 *
 *  2. CROSS-ARM DUPLICATE ID — a step id reused across a branch then/else, across a
 *     switchOn case, across a forEach body, or between an arm and the top level throws
 *     at AUTHOR time (the flat per-workflow id set, ADR 0003). Existing tests only
 *     cover a top-level duplicate.
 *
 *  3. REGISTRATION ORDER across NESTED arms — steps come out in author order at every
 *     level (top level, branch arm, forEach body, branch-arm-containing-a-forEach).
 *
 *  4. CONCURRENCY — two `workflowCallback()` builds whose callbacks each `await` and
 *     register NESTED-ARM steps, run interleaved under `Promise.all`, keep isolated
 *     builder stacks (ADR 0003 AsyncLocalStorage) — no step leaks between them.
 */

// The object-style authoring surface — the OTHER way to write the same workflow.
import { $, branch as objBranch, forEach as objForEach, workflow as objectWorkflow } from "@blokjs/helper";
import { lowerRefs } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, branch, forEach, step, switchOn, tryCatch, workflowCallback } from "../../src/stepBuilder";

// `record(unknown)` output so handle field reads type-check in author-time tests.
const node = defineNode({
	name: "node",
	description: "passthrough used only for its output type",
	input: z.object({}).passthrough(),
	output: z.record(z.unknown()),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

/** Just the step ids in order, recursing into nested branch/forEach arms. */
function idTree(steps: Array<Record<string, unknown>>): unknown {
	return steps.map((s) => {
		if (s.branch) {
			const b = s.branch as { then: Array<Record<string, unknown>>; else?: Array<Record<string, unknown>> };
			return { id: s.id, then: idTree(b.then), ...(b.else ? { else: idTree(b.else) } : {}) };
		}
		if (s.forEach) {
			const f = s.forEach as { do: Array<Record<string, unknown>> };
			return { id: s.id, do: idTree(f.do) };
		}
		return s.id;
	});
}

// ───────────────────────────── (1) GOLDEN-FILE ─────────────────────────────

describe("golden-file: callback-style IR === object-style IR (modulo ref encoding)", () => {
	it("a linear+branch+forEach workflow compiles identically both ways", async () => {
		// ── callback surface ──
		const cb = await workflowCallback(
			"Golden",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const validate = step("validate", node, { name: req.body.name });
				// A second consecutive top-level step so registration ORDER is
				// load-bearing in this golden comparison (not just push-vs-unshift-safe).
				const enrich = step("enrich", node, { id: validate.orderId });
				branch("route", validate.ok, {
					then: () => {
						step("ship", node, { id: enrich.shipId });
					},
					else: () => {
						step("hold", node, { reason: validate.reason });
					},
				});
				forEach(validate.items, (item) => {
					step("save", node, { sku: item.sku });
				});
			},
		);

		// ── object surface — the SAME workflow, hand-authored with `$` + helpers ──
		const obj = objectWorkflow({
			name: "Golden",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				// `$.request` (NOT `$.req`) lowers to `js/ctx.request...` — the canonical
				// root the callback's `@trigger` handle also lowers to. (`$.req` would
				// lower to the `ctx.req` ALIAS string — same value at runtime, different
				// wire bytes — which is the only "modulo ref encoding" wrinkle here.)
				{ id: "validate", use: "node", inputs: { name: $.request.body.name } },
				{ id: "enrich", use: "node", inputs: { id: $.state.validate.orderId } },
				objBranch({
					id: "route",
					when: $.state.validate.ok,
					then: [{ id: "ship", use: "node", inputs: { id: $.state.enrich.shipId } }],
					else: [{ id: "hold", use: "node", inputs: { reason: $.state.validate.reason } }],
				}),
				objForEach({
					id: "itemsResults",
					in: $.state.validate.items,
					as: "items",
					do: [{ id: "save", use: "node", inputs: { sku: $.state.items.sku } }],
				}),
			],
		});

		// The callback IR carries structural {$ref}; running the REAL load-boundary
		// lowerRefs over it collapses every {$ref} → the same js/ctx... wire string
		// the object surface emits directly. branch.when / forEach.in are already
		// bare/js strings on both sides, so lowerRefs leaves them untouched.
		const loweredCb = lowerRefs(cb._config.steps as unknown[]) as Array<Record<string, unknown>>;
		const objSteps = obj._config.steps as unknown as Array<Record<string, unknown>>;

		// Byte-identical modulo ref encoding — same order, same nested arms, same inputs.
		expect(loweredCb).toEqual(objSteps);
	});

	it("the trigger leg, branch when, and forEach in all match the object surface's wire form", async () => {
		const cb = await workflowCallback(
			"GoldenWire",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const v = step("validate", node, { name: req.body.name });
				branch("route", v.ok, {
					then: () => {
						step("ship", node, { id: v.orderId });
					},
				});
				forEach(v.items, (item) => {
					step("save", node, { sku: item.sku });
				});
			},
		);
		const lowered = lowerRefs(cb._config.steps as unknown[]) as Array<Record<string, unknown>>;

		// Trigger leg → ctx.request (NOT ctx.state) — the @trigger root.
		expect((lowered[0].inputs as Record<string, unknown>).name).toBe("js/ctx.request.body.name");
		// branch.when → BARE ctx.state (ADR 0004), exactly what conditionToExpr emits.
		expect((lowered[1].branch as { when: string }).when).toBe("ctx.state.validate.ok");
		// forEach.in → js/ctx.state wire string, exactly what unwrapProxies emits.
		expect((lowered[2].forEach as { in: string }).in).toBe("js/ctx.state.validate.items");
	});
});

// ──────────────────────── (2) CROSS-ARM DUPLICATE ID ───────────────────────

describe("cross-arm duplicate step id throws at author time (flat id set, ADR 0003)", () => {
	it("rejects an id reused across branch then/else arms", async () => {
		await expect(
			workflowCallback("DupBranch", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				branch("route", step("seed", node, {}).flag, {
					then: () => {
						step("dup", node, {});
					},
					else: () => {
						step("dup", node, {});
					},
				});
			}),
		).rejects.toThrow(/Duplicate step id "dup"/);
	});

	it("rejects an id reused between a branch arm and the top level", async () => {
		await expect(
			workflowCallback("DupArmTop", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				branch("route", step("seed", node, {}).flag, {
					then: () => {
						step("work", node, {});
					},
				});
				step("work", node, {}); // collides with the then-arm step
			}),
		).rejects.toThrow(/Duplicate step id "work"/);
	});

	it("rejects an id reused across switchOn case arms", async () => {
		await expect(
			workflowCallback("DupSwitch", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const v = step("v", node, {});
				switchOn(
					v.kind,
					{
						cases: [
							{ when: "a", do: () => step("handle", node, {}) },
							{ when: "b", do: () => step("handle", node, {}) },
						],
					},
					{ id: "route" },
				);
			}),
		).rejects.toThrow(/Duplicate step id "handle"/);
	});

	it("rejects an id reused inside a forEach body vs the top level", async () => {
		await expect(
			workflowCallback("DupForEach", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const v = step("save", node, {}); // top-level "save"
				forEach(v.items, () => {
					step("save", node, {}); // collides with the top-level step
				});
			}),
		).rejects.toThrow(/Duplicate step id "save"/);
	});

	it("rejects an id reused across tryCatch try/catch arms", async () => {
		await expect(
			workflowCallback("DupTryCatch", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				tryCatch("tc", {
					try: () => {
						step("act", node, {});
					},
					catch: () => {
						step("act", node, {});
					},
				});
			}),
		).rejects.toThrow(/Duplicate step id "act"/);
	});
});

// ─────────────────── (3) REGISTRATION ORDER across NESTED arms ──────────────

describe("registration order is preserved across nested arms", () => {
	it("keeps author order at the top level, in arms, and in a branch-arm-containing-a-forEach", async () => {
		const wf = await workflowCallback(
			"Order",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				const a = step("a", node, { x: req.body.x });
				branch("route", a.ok, {
					then: () => {
						step("t1", node, {});
						// a forEach nested INSIDE the then-arm (#422 edge case).
						forEach(a.items, () => {
							step("inner1", node, {});
							step("inner2", node, {});
						});
						step("t2", node, {});
					},
					else: () => {
						step("e1", node, {});
						step("e2", node, {});
					},
				});
				step("z", node, {});
			},
		);

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		expect(idTree(steps)).toEqual([
			"a",
			{
				id: "route",
				then: ["t1", { id: "itemsResults", do: ["inner1", "inner2"] }, "t2"],
				else: ["e1", "e2"],
			},
			"z",
		]);
	});

	// The SUPPORTED async surface is the TOP-LEVEL `build` callback (it is awaited
	// inside `builders.run`). Arm bodies are typed `() => unknown` and run
	// synchronously via `runArm` — an `await` inside an arm would pop the scope
	// before the continuation, so arms are sync-by-contract. This asserts the
	// supported case: top-level awaits AROUND a step and a primitive that contains
	// its own (sync) nested arms.
	it("preserves order when an await interleaves between top-level step() and a primitive with nested arms", async () => {
		const wf = await workflowCallback(
			"OrderAsync",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			async () => {
				const a = step("a", node, {});
				await Promise.resolve();
				branch("route", a.ok, {
					then: () => {
						step("t1", node, {});
						forEach(a.items, () => {
							step("inner", node, {});
						});
						step("t2", node, {});
					},
				});
				await Promise.resolve();
				step("z", node, {});
			},
		);
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		expect(idTree(steps)).toEqual([
			"a",
			{ id: "route", then: ["t1", { id: "itemsResults", do: ["inner"] }, "t2"] },
			"z",
		]);
	});
});

// ───────────────────────────── (4) CONCURRENCY ─────────────────────────────

describe("concurrency safety: nested-arm builds keep isolated builder stacks (ADR 0003)", () => {
	it("two interleaved workflowCallback builds with nested arms do not cross-contaminate", async () => {
		// Each build awaits at the TOP LEVEL — between registering its outer step and
		// entering its (sync) nested arm, and again after the arm — forcing the two
		// builds' AsyncLocalStorage builder stacks to interleave under Promise.all.
		// A shared/global stack would leak steps across the two builds.
		const build = (tag: string) =>
			workflowCallback(
				`WF-${tag}`,
				{ version: "1.0.0", trigger: { http: { method: "POST" } } },
				async (req: TriggerHandle) => {
					const outer = step(`${tag}-outer`, node, { x: req.body.x });
					await Promise.resolve();
					branch(`${tag}-route`, outer.ok, {
						then: () => {
							step(`${tag}-inner1`, node, {});
							step(`${tag}-inner2`, node, {});
						},
					});
					await Promise.resolve();
					step(`${tag}-tail`, node, {});
				},
			);

		const [left, right] = await Promise.all([build("L"), build("R")]);

		expect(idTree(left._config.steps as Array<Record<string, unknown>>)).toEqual([
			"L-outer",
			{ id: "L-route", then: ["L-inner1", "L-inner2"] },
			"L-tail",
		]);
		expect(idTree(right._config.steps as Array<Record<string, unknown>>)).toEqual([
			"R-outer",
			{ id: "R-route", then: ["R-inner1", "R-inner2"] },
			"R-tail",
		]);

		// And no step from one build leaked into the other (the contamination check).
		const leftIds = JSON.stringify(left._config.steps);
		const rightIds = JSON.stringify(right._config.steps);
		expect(leftIds).not.toContain("R-");
		expect(rightIds).not.toContain("L-");
	});
});
