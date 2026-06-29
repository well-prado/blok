import { workflow as arrayWorkflow } from "@blokjs/helper";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../../../src/defineNode";
import { branch, forEach, step, tryCatch, workflowCallback } from "../../../src/stepBuilder";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

const node = defineNode({
	name: "node",
	description: "hybrid normalizer test node",
	input: z.object({}).passthrough(),
	output: z
		.object({
			id: z.string().optional(),
			items: z.array(z.record(z.unknown())).optional(),
			ok: z.boolean().optional(),
			orderId: z.string().optional(),
			reason: z.string().optional(),
			shipId: z.string().optional(),
		})
		.passthrough(),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

describe("WorkflowNormalizer — hybrid DSL equivalence", () => {
	it("handle DSL, v2 array, and v1 normalize to the same internal IR", async () => {
		const handle = await workflowCallback(
			"Hybrid",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req) => {
				const validate = step("validate", node, { name: req.body.name }, { as: "validated" });
				step("respond", node, { id: validate.id }, { ephemeral: true });
			},
		);
		const v2 = arrayWorkflow({
			name: "Hybrid",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{ id: "validate", use: "node", inputs: { name: "js/ctx.request.body.name" }, as: "validated" },
				{ id: "respond", use: "node", inputs: { id: "js/ctx.state.validated.id" }, ephemeral: true },
			],
		});
		const v1 = {
			name: "Hybrid",
			version: "1.0.0",
			trigger: { http: { method: "POST", accept: "application/json" } },
			steps: [
				{ name: "validate", node: "node", type: "module", as: "validated" },
				{ name: "respond", node: "node", type: "module", ephemeral: true },
			],
			nodes: {
				validate: { inputs: { name: "js/ctx.request.body.name" } },
				respond: { inputs: { id: "js/ctx.state.validated.id" } },
			},
		};

		expect(handle._config.schemaVersion).toBe("2");
		expect(normalizeWorkflow(handle)).toEqual(normalizeWorkflow(v2));
		expect(normalizeWorkflow(v1)).toEqual(normalizeWorkflow(v2));
	});

	it("closure branch and forEach lower to the same IR as v2 array primitives", async () => {
		const handle = await workflowCallback(
			"Flow",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req) => {
				const validate = step("validate", node, { name: req.body.name });
				branch("route", validate.ok, {
					then: () => {
						step("ship", node, { id: validate.orderId });
					},
					else: () => {
						step("hold", node, { reason: validate.reason });
					},
				});
				forEach(
					validate.items,
					(item) => {
						step("save", node, { sku: item.sku });
					},
					{ id: "itemsLoop", as: "item", mode: "parallel", concurrency: 2 },
				);
			},
		);
		const v2 = arrayWorkflow({
			name: "Flow",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{ id: "validate", use: "node", inputs: { name: "js/ctx.request.body.name" } },
				{
					id: "route",
					branch: {
						when: "ctx.state.validate.ok",
						then: [{ id: "ship", use: "node", inputs: { id: "js/ctx.state.validate.orderId" } }],
						else: [{ id: "hold", use: "node", inputs: { reason: "js/ctx.state.validate.reason" } }],
					},
				},
				{
					id: "itemsLoop",
					forEach: {
						in: "js/ctx.state.validate.items",
						as: "item",
						mode: "parallel",
						concurrency: 2,
						do: [{ id: "save", use: "node", inputs: { sku: "js/ctx.state.item.sku" } }],
					},
				},
			],
		});

		expect(normalizeWorkflow(handle)).toEqual(normalizeWorkflow(v2));
	});

	it("preserves nested branch-in-forEach-in-tryCatch order and node configs", async () => {
		const handle = await workflowCallback("Nested", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			const seed = step("seed", node, {});
			tryCatch("guarded", {
				try: () => {
					forEach(
						seed.items,
						(item) => {
							branch("innerRoute", item.ok, {
								then: () => {
									step("inner", node, { id: item.id });
								},
							});
						},
						{ id: "loop", as: "item" },
					);
				},
				catch: (error) => {
					step("capture", node, { message: error.message });
				},
			});
		});

		const out = normalizeWorkflow(handle);
		expect(out.steps.map((s) => s.name)).toEqual(["seed", "guarded"]);
		expect((out.nodes.guarded.try as Array<{ name: string }>).map((s) => s.name)).toEqual(["loop"]);
		expect(out.nodes.loop.steps?.map((s) => s.name)).toEqual(["innerRoute"]);
		expect(out.nodes.innerRoute.conditions?.[0].steps.map((s) => s.name)).toEqual(["inner"]);
		expect((out.nodes.guarded.catch as Array<{ name: string }>).map((s) => s.name)).toEqual(["capture"]);
	});
});

/**
 * Narrow conflict guard (#391 redo). The reverted `assertWorkflowDslMode`
 * flagged the canonical `{id, node}` hybrid as "mixed mode" and broke every
 * SSE/WS/HTTP/MCP trigger workflow. The successor rejects ONLY genuine
 * conflicts: two fields on the SAME axis (`name`+`id`, `node`+`use`) or an
 * explicit `schemaVersion: "2"` envelope still carrying a legacy `nodes{}` map.
 * Everything the corpus legitimately does — `{id, node}` hybrids, freely mixed
 * `{name,node}` and `{id,use}` steps — must pass.
 */
describe("WorkflowNormalizer — narrow DSL-conflict rejection (#391)", () => {
	const base = { name: "WF", version: "1.0.0", trigger: { http: { method: "GET" as const } } };

	it("ACCEPTS the canonical {id, node} hybrid (the regression that broke 4 trigger suites)", () => {
		expect(() => normalizeWorkflow({ ...base, steps: [{ id: "read", node: "node", type: "module" }] })).not.toThrow();
	});

	it("ACCEPTS a workflow freely mixing {name,node} and {id,use} steps", () => {
		expect(() =>
			normalizeWorkflow({
				...base,
				steps: [
					{ name: "legacy", node: "node", type: "module" },
					{ id: "modern", use: "node" },
				],
				nodes: { legacy: { inputs: {} } },
			}),
		).not.toThrow();
	});

	it("REJECTS a step that sets BOTH name and id (two identities)", () => {
		expect(() => normalizeWorkflow({ ...base, steps: [{ name: "a", id: "b", node: "node", type: "module" }] })).toThrow(
			/sets BOTH `name` .* and `id`/,
		);
	});

	it("REJECTS a step that sets BOTH node and use (two refs)", () => {
		expect(() => normalizeWorkflow({ ...base, steps: [{ id: "x", node: "node", use: "node" }] })).toThrow(
			/sets BOTH `node` .* and `use`/,
		);
	});

	it("REJECTS schemaVersion '2' carrying a legacy non-empty nodes{} map", () => {
		expect(() =>
			normalizeWorkflow({
				schemaVersion: "2",
				...base,
				steps: [{ id: "read", use: "node" }],
				nodes: { read: { inputs: {} } },
			}),
		).toThrow(/schemaVersion: "2".*nodes\{\}/);
	});

	it("ACCEPTS schemaVersion '2' with an EMPTY nodes{} map (vestigial, not half-migrated)", () => {
		expect(() =>
			normalizeWorkflow({ schemaVersion: "2", ...base, steps: [{ id: "read", use: "node" }], nodes: {} }),
		).not.toThrow();
	});

	it("detects a conflict nested inside a branch arm (recursive walk)", () => {
		expect(() =>
			normalizeWorkflow({
				...base,
				steps: [
					{
						id: "route",
						branch: {
							when: "ctx.request.body.x",
							then: [{ name: "a", id: "b", use: "node" }],
							else: [{ id: "ok", use: "node" }],
						},
					},
				],
			}),
		).toThrow(/steps\[0\]\.branch\.then\[0\] sets BOTH `name` .* and `id`/);
	});
});
