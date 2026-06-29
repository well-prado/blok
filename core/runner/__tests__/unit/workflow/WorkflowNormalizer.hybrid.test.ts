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

describe("WorkflowNormalizer — explicit mode gate and mixed-mode rejection", () => {
	it("uses schemaVersion 2 as the explicit v2 gate and rejects legacy nodes{}", () => {
		expect(() =>
			normalizeWorkflow({
				schemaVersion: "2",
				name: "Mixed",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "read", use: "node" }],
				nodes: { read: { inputs: {} } },
			}),
		).toThrow(/schemaVersion: "2".*nodes\{\}/);
	});

	it("rejects v1 steps inside an explicit v2 workflow", () => {
		expect(() =>
			normalizeWorkflow({
				schemaVersion: "2",
				name: "Mixed",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [
					{ id: "read", use: "node" },
					{ name: "legacy", node: "node", type: "module" },
				],
			}),
		).toThrow(/v1 step at steps\[1\].*explicit v2 workflow/);
	});

	it("rejects structurally mixed v1 and v2 steps when no schemaVersion is present", () => {
		expect(() =>
			normalizeWorkflow({
				name: "Mixed",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [
					{ name: "legacy", node: "node", type: "module" },
					{ id: "read", use: "node" },
				],
			}),
		).toThrow(/found both v1 steps.*v2\/handle steps/);
	});

	it("rejects unsupported schemaVersion values before structural fallback", () => {
		expect(() =>
			normalizeWorkflow({
				schemaVersion: "3",
				name: "Future",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ id: "read", use: "node" }],
			}),
		).toThrow(/unsupported schemaVersion "3"/);
	});
});
