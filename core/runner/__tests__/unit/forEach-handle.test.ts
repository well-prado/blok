/**
 * forEach(iterable, (item, index?) => { ... }, opts?) over handles
 * (#329 forEach slice + #343 per-item handle).
 *
 * Proves the full authoring → IR → real-engine path:
 *
 *  (a) the iterable handle lowers to the forEach `in` expression as a
 *      `js/ctx.state...` (or `js/ctx.request...`) STRING — NOT a `{$ref}`.
 *      (The normalizer does not lowerRefs over `forEach.in`, and ForEachNode
 *      reads `opts.in` only after the Mapper resolves it.)
 *  (b) the per-item handle (`item.field`) inside the body lowers to
 *      `{$ref}` rooted at the loop's `as` key → `ctx.state.<as>.field`.
 *  (c) booted through the REAL Configuration + ForEachNode + Runner over a
 *      2-item array, each item is processed with correct per-item resolution.
 *
 * Plus the arm-scope guard (ADR 0003/0005, #343): the per-item handle read
 * AFTER the forEach (outside the body scope) is REJECTED at author time — the
 * SAME cornerstone `canRead` guard branch() exercises.
 *
 * SCOPE: forEach only. switch/tryCatch/loop handle-arm integration are the
 * next wave.
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import { type TriggerHandle, forEach, makeHandle, step, workflowCallback } from "../../src/stepBuilder";
import type GlobalOptions from "../../src/types/GlobalOptions";

const noop = defineNode({
	name: "noop",
	description: "passthrough used only for its output type in author-time tests",
	input: z.object({}).passthrough(),
	output: z.record(z.unknown()),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

// ───────────────────────── (a)+(b): IR-shape assertions ─────────────────────

describe("forEach — IR lowering (#329 / #343)", () => {
	it("lowers the iterable to a js/ctx.state `in` string and the item handle to a {$ref} at state.<as>", async () => {
		const wf = await workflowCallback("Save", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			forEach(validate.items, (item) => {
				step("save", noop, { sku: item.sku });
			});
		});

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const fe = steps.find((s) => s.forEach) as {
			id: string;
			forEach: { in: string; as: string; do: Array<Record<string, unknown>> };
		};

		// (a) `in` is the lowered wire string — NOT a {$ref}, NOT a $. proxy.
		expect(fe.forEach.in).toBe("js/ctx.state.validate.items");
		expect(typeof fe.forEach.in).toBe("string");
		// derived `as` from the iterable's last path segment; `id` distinct.
		expect(fe.forEach.as).toBe("items");
		expect(fe.id).toBe("itemsResults");

		// (b) the per-item handle lowers to a {$ref} rooted at the `as` key.
		expect(fe.forEach.do.map((s) => s.id)).toEqual(["save"]);
		expect(fe.forEach.do[0].inputs).toEqual({ sku: { $ref: { step: "items", path: ["sku"] } } });
	});

	it("honors opts.as / opts.id and exposes a per-item index handle rooted at <as>Index", async () => {
		const wf = await workflowCallback(
			"Indexed",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: TriggerHandle) => {
				forEach(
					req.body.rows,
					(item, index) => {
						step("emit", noop, { value: item.v, at: index });
					},
					{ id: "loop", as: "row" },
				);
			},
		);
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const fe = steps.find((s) => s.forEach) as {
			id: string;
			forEach: { in: string; as: string; do: Array<Record<string, unknown>> };
		};
		// iterable is a trigger field → ctx.request.
		expect(fe.forEach.in).toBe("js/ctx.request.body.rows");
		expect(fe.id).toBe("loop");
		expect(fe.forEach.as).toBe("row");
		// item → {$ref step:"row"}; index → {$ref step:"rowIndex"}.
		expect(fe.forEach.do[0].inputs).toEqual({
			value: { $ref: { step: "row", path: ["v"] } },
			at: { $ref: { step: "rowIndex", path: [] } },
		});
	});
});

// ───────────────────── arm-scope guard (ADR 0003/0005, #343) ────────────────

describe("forEach — per-item handle is body-scoped (cornerstone canRead)", () => {
	it("rejects the per-item handle read AFTER the forEach", async () => {
		await expect(
			workflowCallback("Leak", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const validate = step("validate", noop, {});
				let leaked: Parameters<Parameters<typeof forEach>[1]>[0] | undefined;
				forEach(validate.items, (item) => {
					leaked = item;
					step("save", noop, { sku: item.sku });
				});
				// reading the per-item handle outside the body scope must throw.
				step("after", noop, { x: (leaked as { stray: unknown }).stray });
			}),
		).rejects.toThrow(/outside its scope/);
	});

	it("rejects the per-item handle read from a SIBLING forEach body", async () => {
		await expect(
			workflowCallback("SiblingLeak", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const a = step("a", noop, {});
				const b = step("b", noop, {});
				let leaked: Parameters<Parameters<typeof forEach>[1]>[0] | undefined;
				forEach(
					a.items,
					(item) => {
						leaked = item;
						step("ia", noop, { x: item.x }, { as: "ra" });
					},
					{ id: "loopA", as: "ea" },
				);
				forEach(
					b.items,
					() => {
						// reading the FIRST loop's item from the SECOND loop's body must throw.
						step("ib", noop, { x: (leaked as { x: unknown }).x }, { as: "rb" });
					},
					{ id: "loopB", as: "eb" },
				);
			}),
		).rejects.toThrow(/outside its scope/);
	});

	it.each(["row", "rowIndex"])("rejects forEach `as` scope collision with sibling state key %s", async (reservedId) => {
		await expect(
			workflowCallback("Collision", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				const validate = step("validate", noop, {});
				step(reservedId, noop, {});
				forEach(
					validate.items,
					(item) => {
						step("save", noop, { sku: item.sku });
					},
					{ id: "loop", as: "row" },
				);
			}),
		).rejects.toThrow(/forEach state key "row(Index)?".*collides/);
	});
});

// ───────────────────── (c): real Configuration + ForEachNode + Runner ───────

class CtxPublishNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/ctx-publish";
		this.node = "@blokjs/ctx-publish";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { name?: string; value?: unknown };
		};
		const name = opts.inputs?.name ?? "";
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[name] = opts.inputs?.value;
		return { success: true, data: { name, value: opts.inputs?.value }, error: null };
	}
}

async function bootAndRun(workflowDef: unknown): Promise<Record<string, unknown>> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/ctx-publish": new CtxPublishNode(),
	};
	const globalOptions = {
		nodes: { getNode: (name: string): RunnerNode | null => helpers[name] ?? null },
	} as unknown as GlobalOptions;
	await config.init("foreach-e2e", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "req",
		workflow_name: "foreach-e2e",
		workflow_path: "/x",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger: {
			log: () => {},
			logLevel: () => {},
			error: () => {},
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	await new Runner(config.steps as NodeBase[]).run(ctx);
	return ctx.state as Record<string, unknown>;
}

describe("forEach — real Configuration + ForEachNode + Runner", () => {
	it("processes each item with correct per-item handle resolution over a 2-item array", async () => {
		// Author the loop via the handle DSL; assert its IR, then run THAT IR
		// (with the iterable source seeded into state via ctx-publish).
		const wf = await workflowCallback("Echo", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			forEach(
				validate.items,
				(item) => {
					// echo the per-item sku back out — proves ctx.state.<as>.sku resolves.
					step("echo", noop, { sku: item.sku }, { as: "echoed" });
				},
				{ id: "loop", as: "row" },
			);
		});
		const authored = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.forEach) as {
			forEach: { in: string; as: string; do: Array<Record<string, unknown>> };
		};
		// Sanity: the authored `in` is the lowered wire string.
		expect(authored.forEach.in).toBe("js/ctx.state.validate.items");

		const def = {
			name: "echo-loop",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "validate", value: { items: [{ sku: "A" }, { sku: "B" }] } },
				},
				{
					id: "loop",
					forEach: {
						in: authored.forEach.in,
						as: authored.forEach.as,
						mode: "sequential",
						do: [
							{
								// the inner step writes ctx.state[<as>].sku → state.row.sku per iteration.
								id: "echo",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "perItem", value: "js/ctx.state.row.sku" },
							},
						],
					},
				},
			],
		};

		const state = await bootAndRun(def);
		// ForEachNode aggregates each iteration's result (ctx-publish returns
		// { name, value }); value is the per-item sku, proving correct resolution.
		expect(state.loop).toEqual([
			{ name: "perItem", value: "A" },
			{ name: "perItem", value: "B" },
		]);
	});

	it.each([
		{ mode: "sequential" as const, concurrency: undefined },
		{ mode: "parallel" as const, concurrency: 4 },
	])("keeps per-item handle and index isolated in $mode mode", async ({ mode, concurrency }) => {
		const wf = await workflowCallback("Isolated", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			forEach(
				validate.items,
				(item, index) => {
					step("echo", noop, { id: item.id, original: item.original, index }, { as: "echoed" });
				},
				{ id: "loop", as: "row", mode, ...(concurrency ? { concurrency } : {}) },
			);
		});
		const authored = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.forEach) as {
			forEach: { in: string; as: string; do: Array<Record<string, unknown>> };
		};
		expect(authored.forEach.do[0].inputs).toEqual({
			id: { $ref: { step: "row", path: ["id"] } },
			original: { $ref: { step: "row", path: ["original"] } },
			index: { $ref: { step: "rowIndex", path: [] } },
		});

		const def = {
			name: `isolated-${mode}`,
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: {
						name: "validate",
						value: {
							items: [
								{ id: "A", original: "alpha" },
								{ id: "B", original: "bravo" },
								{ id: "C", original: "charlie" },
								{ id: "D", original: "delta" },
							],
						},
					},
				},
				{
					id: "loop",
					forEach: {
						in: authored.forEach.in,
						as: authored.forEach.as,
						mode,
						...(concurrency ? { concurrency } : {}),
						do: [
							{
								id: "shadow-row",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: {
									name: "row",
									value: {
										id: "js/ctx.state.row.id",
										original: "js/ctx.state.row.original",
										shadow: "js/`${ctx.state.row.id}:${ctx.state.rowIndex}`",
									},
								},
							},
							{
								id: "echo",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: {
									name: "perItem",
									value: {
										id: "js/ctx.state.row.id",
										original: "js/ctx.state.row.original",
										shadow: "js/ctx.state.row.shadow",
										index: "js/ctx.state.rowIndex",
									},
								},
							},
						],
					},
				},
			],
		};

		const state = await bootAndRun(def);
		expect(state.loop).toEqual([
			{ name: "perItem", value: { id: "A", original: "alpha", shadow: "A:0", index: 0 } },
			{ name: "perItem", value: { id: "B", original: "bravo", shadow: "B:1", index: 1 } },
			{ name: "perItem", value: { id: "C", original: "charlie", shadow: "C:2", index: 2 } },
			{ name: "perItem", value: { id: "D", original: "delta", shadow: "D:3", index: 3 } },
		]);
		expect(state.row).toBeUndefined();
		expect(state.rowIndex).toBeUndefined();
	});

	it("returns an empty aggregate for an empty iterable without binding the item handle", async () => {
		const wf = await workflowCallback("Empty", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			forEach(
				validate.items,
				(item) => {
					step("echo", noop, { id: item.id });
				},
				{ id: "loop", as: "row" },
			);
		});
		const authored = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.forEach) as {
			forEach: { in: string; as: string };
		};

		const state = await bootAndRun({
			name: "empty-loop",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "validate", value: { items: [] } },
				},
				{
					id: "loop",
					forEach: {
						in: authored.forEach.in,
						as: authored.forEach.as,
						do: [
							{
								id: "echo",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "perItem", value: "js/ctx.state.row.id" },
							},
						],
					},
				},
			],
		});

		expect(state.loop).toEqual([]);
		expect(state.row).toBeUndefined();
		expect(state.rowIndex).toBeUndefined();
		expect(state.perItem).toBeUndefined();
	});

	it.each([
		["undefined", {}],
		["null", { items: null }],
		["object", { items: { id: "not-array" } }],
	])("treats a mapper-resolved %s iterable handle as an empty array", async (_label, validateValue) => {
		const wf = await workflowCallback("NonArray", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const validate = step("validate", noop, {});
			forEach(
				validate.items,
				(item) => {
					step("echo", noop, { id: item.id });
				},
				{ id: "loop", as: "row" },
			);
		});
		const authored = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.forEach) as {
			forEach: { in: string; as: string };
		};

		const state = await bootAndRun({
			name: "non-array-loop",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "validate", value: validateValue },
				},
				{
					id: "loop",
					forEach: {
						in: authored.forEach.in,
						as: authored.forEach.as,
						do: [
							{
								id: "echo",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "perItem", value: "js/ctx.state.row.id" },
							},
						],
					},
				},
			],
		});

		expect(state.loop).toEqual([]);
		expect(state.row).toBeUndefined();
		expect(state.rowIndex).toBeUndefined();
		expect(state.perItem).toBeUndefined();
	});

	it("makes the returned forEach handle read the aggregate array after the loop", async () => {
		const wf = await workflowCallback(
			"AfterAggregate",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			() => {
				const validate = step("validate", noop, {});
				const results = forEach(
					validate.items,
					(item) => {
						step("echo", noop, { id: item.id });
					},
					{ id: "loop", as: "row" },
				);
				step("after", noop, { results });
			},
		);
		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const authored = steps.find((s) => s.forEach) as { forEach: { in: string; as: string } };
		expect(steps.find((s) => s.id === "after")?.inputs).toEqual({
			results: { $ref: { step: "loop", path: [] } },
		});

		const state = await bootAndRun({
			name: "after-aggregate",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "seed",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "validate", value: { items: [{ id: "A" }, { id: "B" }] } },
				},
				{
					id: "loop",
					forEach: {
						in: authored.forEach.in,
						as: authored.forEach.as,
						do: [
							{
								id: "echo",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "perItem", value: "js/ctx.state.row.id" },
							},
						],
					},
				},
				{
					id: "after",
					use: "@blokjs/ctx-publish",
					type: "module",
					inputs: { name: "afterLoop", value: "js/ctx.state.loop" },
				},
			],
		});

		expect(state.afterLoop).toEqual([
			{ name: "perItem", value: "A" },
			{ name: "perItem", value: "B" },
		]);
	});
});
