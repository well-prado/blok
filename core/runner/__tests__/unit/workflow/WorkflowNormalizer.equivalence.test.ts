import { workflow as arrayWorkflow } from "@blokjs/helper";
import IfElse from "@blokjs/if-else";
import type { Context, NodeBase } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../../src/Configuration";
import Runner from "../../../src/Runner";
import { defineNode } from "../../../src/defineNode";
import type { Handle } from "../../../src/handles";
import { branch, forEach, state, step, workflowCallback } from "../../../src/stepBuilder";
import type GlobalOptions from "../../../src/types/GlobalOptions";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

type StepTrace = { step: string; input: unknown; output: unknown };
type RunSnapshot = {
	ir: unknown;
	trace: StepTrace[];
	state: Record<string, unknown>;
	response: unknown;
};

const itemSchema = z.object({ sku: z.string(), qty: z.number() });

const seedNode = defineNode({
	name: "@test/equivalence.seed",
	description: "test fixture: seed order state",
	input: z.object({
		trace: z.string(),
		orderId: z.string(),
		region: z.string(),
		expedited: z.boolean(),
		items: z.array(itemSchema),
	}),
	output: z.object({
		orderId: z.string(),
		region: z.string(),
		expedited: z.boolean(),
		items: z.array(itemSchema),
	}),
	execute: (ctx, input) => record(ctx, input.trace, input, { ...input, trace: undefined }),
});

const auditNode = defineNode({
	name: "@test/equivalence.audit",
	description: "test fixture: ephemeral audit",
	input: z.object({ trace: z.string(), orderId: z.string() }),
	output: z.object({ audited: z.string() }),
	execute: (ctx, input) => record(ctx, input.trace, input, { audited: input.orderId }),
});

const metadataNode = defineNode({
	name: "@test/equivalence.metadata",
	description: "test fixture: spread metadata",
	input: z.object({ trace: z.string(), region: z.string() }),
	output: z.object({ region: z.string(), channel: z.string() }),
	execute: (ctx, input) => record(ctx, input.trace, input, { region: input.region, channel: "web" }),
});

const decisionNode = defineNode({
	name: "@test/equivalence.decision",
	description: "test fixture: branch decision",
	input: z.object({
		trace: z.string(),
		branch: z.enum(["ship", "hold"]),
		orderId: z.string(),
		region: z.string(),
	}),
	output: z.object({
		branch: z.enum(["ship", "hold"]),
		orderId: z.string(),
		region: z.string(),
	}),
	execute: (ctx, input) =>
		record(ctx, input.trace, input, { branch: input.branch, orderId: input.orderId, region: input.region }),
});

const lineNode = defineNode({
	name: "@test/equivalence.line",
	description: "test fixture: per-item line",
	input: z.object({
		trace: z.string(),
		sku: z.string(),
		qty: z.number(),
		index: z.number(),
		orderId: z.string(),
		region: z.string(),
	}),
	output: z.object({
		sku: z.string(),
		qty: z.number(),
		index: z.number(),
		orderId: z.string(),
		region: z.string(),
		label: z.string(),
	}),
	execute: (ctx, input) =>
		record(ctx, input.trace, input, {
			sku: input.sku,
			qty: input.qty,
			index: input.index,
			orderId: input.orderId,
			region: input.region,
			label: `${input.orderId}:${input.sku}:${input.index}`,
		}),
});

const finalNode = defineNode({
	name: "@test/equivalence.final",
	description: "test fixture: final response",
	input: z.object({
		trace: z.string(),
		orderId: z.string(),
		branch: z.enum(["ship", "hold"]),
		region: z.string(),
		channel: z.string(),
		firstLineLabel: z.string(),
		secondLineIndex: z.number(),
	}),
	output: z.object({
		orderId: z.string(),
		branch: z.enum(["ship", "hold"]),
		region: z.string(),
		channel: z.string(),
		firstLineLabel: z.string(),
		secondLineIndex: z.number(),
	}),
	execute: (ctx, input) =>
		record(ctx, input.trace, input, {
			orderId: input.orderId,
			branch: input.branch,
			region: input.region,
			channel: input.channel,
			firstLineLabel: input.firstLineLabel,
			secondLineIndex: input.secondLineIndex,
		}),
});

const nodes = {
	[seedNode.name]: seedNode,
	[auditNode.name]: auditNode,
	[metadataNode.name]: metadataNode,
	[decisionNode.name]: decisionNode,
	[lineNode.name]: lineNode,
	[finalNode.name]: finalNode,
	"@blokjs/if-else": IfElse,
};

const body = {
	orderId: "ord_123",
	region: "na",
	expedited: true,
	items: [
		{ sku: "a", qty: 2 },
		{ sku: "b", qty: 3 },
	],
};

describe("WorkflowNormalizer equivalence: three DSLs, one resolved IR", () => {
	it("resolves handle DSL, v2 array, and v1 array/config to the same IR", async () => {
		const snapshots = await runAll({ ...body, expedited: true });

		expect(snapshots.handle.ir).toEqual(snapshots.v2.ir);
		expect(snapshots.v1.ir).toEqual(snapshots.v2.ir);
	});

	it.each([
		{ expedited: true, branch: "ship" },
		{ expedited: false, branch: "hold" },
	])(
		"runs with identical trace, state, and response for branch=$branch",
		async ({ expedited, branch: expectedBranch }) => {
			const snapshots = await runAll({ ...body, expedited });

			expect(snapshots.handle.trace).toEqual(snapshots.v2.trace);
			expect(snapshots.v1.trace).toEqual(snapshots.v2.trace);
			expect(snapshots.handle.state).toEqual(snapshots.v2.state);
			expect(snapshots.v1.state).toEqual(snapshots.v2.state);
			expect(snapshots.handle.response).toEqual(snapshots.v2.response);
			expect(snapshots.v1.response).toEqual(snapshots.v2.response);

			const state = snapshots.handle.state;
			expect(state.audit).toBeUndefined();
			expect(state.ship).toBeUndefined();
			expect(state.hold).toBeUndefined();
			expect(state.decision).toMatchObject({ branch: expectedBranch });
			expect(state.lines).toEqual([
				{ sku: "a", qty: 2, index: 0, orderId: "ord_123", region: "na", label: "ord_123:a:0" },
				{ sku: "b", qty: 3, index: 1, orderId: "ord_123", region: "na", label: "ord_123:b:1" },
			]);
			expect(state.final).toEqual({
				orderId: "ord_123",
				branch: expectedBranch,
				region: "na",
				channel: "web",
				firstLineLabel: "ord_123:a:0",
				secondLineIndex: 1,
			});
		},
	);

	it("rejects partially migrated mixed-mode files", () => {
		expect(() =>
			normalizeWorkflow({
				schemaVersion: "2",
				name: "mixed",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				steps: [
					{ id: "seed", use: seedNode.name, inputs: { trace: "seed" } },
					{ name: "legacy", node: seedNode.name, type: "module" },
				],
			}),
		).toThrow(/v1 step at steps\[1\].*explicit v2 workflow/);
	});

	it("rejects cross-arm duplicate ids while allowing shared as aliases", async () => {
		await expect(
			workflowCallback("dup", { version: "1.0.0", trigger: { http: { method: "POST" } } }, (req) => {
				const seed = step("seed", seedNode, {
					trace: "seed",
					orderId: req.body.orderId,
					region: req.body.region,
					expedited: req.body.expedited,
					items: req.body.items,
				});
				branch("route", seed.expedited, {
					then: () => {
						step("same", decisionNode, { trace: "ship", branch: "ship", orderId: seed.orderId, region: seed.region });
					},
					else: () => {
						step("same", decisionNode, { trace: "hold", branch: "hold", orderId: seed.orderId, region: seed.region });
					},
				});
			}),
		).rejects.toThrow(/Duplicate step id "same"/);
	});

	it("conditional step registration inside a closure is deterministic", async () => {
		const enabledSteps = new Set(["always"]);
		const wf = await workflowCallback(
			"conditional",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			() => {
				if (enabledSteps.has("never")) step("never", auditNode, { trace: "never", orderId: "x" });
				if (enabledSteps.has("always")) step("always", auditNode, { trace: "always", orderId: "x" });
			},
		);

		expect(wf._config.steps).toEqual([
			{ id: "always", use: auditNode.name, inputs: { trace: "always", orderId: "x" } },
		]);
	});
});

async function runAll(input: typeof body): Promise<Record<"handle" | "v2" | "v1", RunSnapshot>> {
	const [handle, v2, v1] = await Promise.all([
		buildHandleWorkflow(),
		Promise.resolve(buildV2Workflow()),
		Promise.resolve(buildV1Workflow()),
	]);
	return {
		handle: await runWorkflow(handle, input),
		v2: await runWorkflow(v2, input),
		v1: await runWorkflow(v1, input),
	};
}

async function buildHandleWorkflow() {
	return await workflowCallback("equivalence", { version: "1.0.0", trigger: { http: { method: "POST" } } }, (req) => {
		const order = step(
			"seed",
			seedNode,
			{
				trace: "seed",
				orderId: req.body.orderId,
				region: req.body.region,
				expedited: req.body.expedited,
				items: req.body.items,
			},
			{ as: "order" },
		);
		step("audit", auditNode, { trace: "audit", orderId: order.orderId }, { ephemeral: true });
		const metadata = step("metadata", metadataNode, { trace: "metadata", region: order.region }, { spread: true });

		branch("route", order.expedited, {
			then: () => {
				step(
					"ship",
					decisionNode,
					{ trace: "ship", branch: "ship", orderId: order.orderId, region: metadata.region },
					{ as: "decision" },
				);
			},
			else: () => {
				step(
					"hold",
					decisionNode,
					{ trace: "hold", branch: "hold", orderId: order.orderId, region: metadata.region },
					{ as: "decision" },
				);
			},
		});

		const lines = forEach(
			order.items,
			(item, index) => {
				step(
					"line",
					lineNode,
					{
						trace: "line",
						sku: item.sku,
						qty: item.qty,
						index,
						orderId: order.orderId,
						region: metadata.region,
					},
					{ as: "latestLine" },
				);
			},
			{ id: "lines", as: "lineItem", mode: "sequential" },
		) as unknown as Handle<Array<{ label: string; index: number }>>;
		const decision = state("decision") as unknown as Handle<{ branch: "ship" | "hold" }>;

		step("final", finalNode, {
			trace: "final",
			orderId: order.orderId,
			branch: decision.branch,
			region: metadata.region,
			channel: metadata.channel,
			firstLineLabel: lines[0].label,
			secondLineIndex: lines[1].index,
		});
	});
}

function buildV2Workflow() {
	return arrayWorkflow({
		name: "equivalence",
		version: "1.0.0",
		trigger: { http: { method: "POST" } },
		steps: [
			{
				id: "seed",
				use: seedNode.name,
				as: "order",
				inputs: {
					trace: "seed",
					orderId: "js/ctx.request.body.orderId",
					region: "js/ctx.request.body.region",
					expedited: "js/ctx.request.body.expedited",
					items: "js/ctx.request.body.items",
				},
			},
			{
				id: "audit",
				use: auditNode.name,
				ephemeral: true,
				inputs: { trace: "audit", orderId: "js/ctx.state.order.orderId" },
			},
			{
				id: "metadata",
				use: metadataNode.name,
				spread: true,
				inputs: { trace: "metadata", region: "js/ctx.state.order.region" },
			},
			{
				id: "route",
				branch: {
					when: "ctx.state.order.expedited",
					then: [
						{
							id: "ship",
							use: decisionNode.name,
							as: "decision",
							inputs: {
								trace: "ship",
								branch: "ship",
								orderId: "js/ctx.state.order.orderId",
								region: "js/ctx.state.region",
							},
						},
					],
					else: [
						{
							id: "hold",
							use: decisionNode.name,
							as: "decision",
							inputs: {
								trace: "hold",
								branch: "hold",
								orderId: "js/ctx.state.order.orderId",
								region: "js/ctx.state.region",
							},
						},
					],
				},
			},
			{
				id: "lines",
				forEach: {
					in: "js/ctx.state.order.items",
					as: "lineItem",
					mode: "sequential",
					do: [
						{
							id: "line",
							use: lineNode.name,
							as: "latestLine",
							inputs: {
								trace: "line",
								sku: "js/ctx.state.lineItem.sku",
								qty: "js/ctx.state.lineItem.qty",
								index: "js/ctx.state.lineItemIndex",
								orderId: "js/ctx.state.order.orderId",
								region: "js/ctx.state.region",
							},
						},
					],
				},
			},
			{
				id: "final",
				use: finalNode.name,
				inputs: {
					trace: "final",
					orderId: "js/ctx.state.order.orderId",
					branch: "js/ctx.state.decision.branch",
					region: "js/ctx.state.region",
					channel: "js/ctx.state.channel",
					firstLineLabel: "js/ctx.state.lines[0].label",
					secondLineIndex: "js/ctx.state.lines[1].index",
				},
			},
		],
	});
}

function buildV1Workflow() {
	return {
		name: "equivalence",
		version: "1.0.0",
		trigger: { http: { method: "POST" } },
		steps: [
			{ name: "seed", node: seedNode.name, type: "module", as: "order" },
			{ name: "audit", node: auditNode.name, type: "module", ephemeral: true },
			{ name: "metadata", node: metadataNode.name, type: "module", spread: true },
			{ name: "route", node: "@blokjs/if-else", type: "module" },
			{ name: "lines", node: "@blokjs/forEach", type: "forEach" },
			{ name: "final", node: finalNode.name, type: "module" },
		],
		nodes: {
			seed: {
				inputs: {
					trace: "seed",
					orderId: "js/ctx.request.body.orderId",
					region: "js/ctx.request.body.region",
					expedited: "js/ctx.request.body.expedited",
					items: "js/ctx.request.body.items",
				},
			},
			audit: { inputs: { trace: "audit", orderId: "js/ctx.state.order.orderId" } },
			metadata: { inputs: { trace: "metadata", region: "js/ctx.state.order.region" } },
			route: {
				conditions: [
					{
						type: "if",
						condition: "ctx.state.order.expedited",
						steps: [{ name: "ship", node: decisionNode.name, type: "module", as: "decision" }],
					},
					{
						type: "else",
						steps: [{ name: "hold", node: decisionNode.name, type: "module", as: "decision" }],
					},
				],
			},
			ship: {
				inputs: {
					trace: "ship",
					branch: "ship",
					orderId: "js/ctx.state.order.orderId",
					region: "js/ctx.state.region",
				},
			},
			hold: {
				inputs: {
					trace: "hold",
					branch: "hold",
					orderId: "js/ctx.state.order.orderId",
					region: "js/ctx.state.region",
				},
			},
			lines: {
				in: "js/ctx.state.order.items",
				as: "lineItem",
				mode: "sequential",
				concurrency: 10,
				steps: [{ name: "line", node: lineNode.name, type: "module", as: "latestLine" }],
			},
			line: {
				inputs: {
					trace: "line",
					sku: "js/ctx.state.lineItem.sku",
					qty: "js/ctx.state.lineItem.qty",
					index: "js/ctx.state.lineItemIndex",
					orderId: "js/ctx.state.order.orderId",
					region: "js/ctx.state.region",
				},
			},
			final: {
				inputs: {
					trace: "final",
					orderId: "js/ctx.state.order.orderId",
					branch: "js/ctx.state.decision.branch",
					region: "js/ctx.state.region",
					channel: "js/ctx.state.channel",
					firstLineLabel: "js/ctx.state.lines[0].label",
					secondLineIndex: "js/ctx.state.lines[1].index",
				},
			},
		},
	};
}

async function runWorkflow(rawWorkflow: unknown, input: typeof body): Promise<RunSnapshot> {
	const trace: StepTrace[] = [];
	const config = new Configuration();
	const globalOptions = {
		nodes: {
			getNode: (name: string) => nodes[name as keyof typeof nodes] ?? null,
		},
	} as unknown as GlobalOptions;
	await config.init("equivalence", globalOptions, rawWorkflow);

	const state: Record<string, unknown> = {};
	const logger = quietLogger();
	const ctx = {
		id: "req",
		workflow_name: "equivalence",
		workflow_path: "equivalence",
		request: { body: input, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger,
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: logger,
		_PRIVATE_: { trace },
	} as unknown as Context;

	await new Runner(config.steps as NodeBase[]).run(ctx);
	return {
		ir: resolvedIr(config),
		trace,
		state: clone(ctx.state),
		response: clone(ctx.response.data),
	};
}

function resolvedIr(config: Configuration): unknown {
	return {
		steps: config.steps.map(stepIr),
		nodes: Object.fromEntries(Object.entries(config.nodes).map(([key, value]) => [key, nodeConfigIr(value)])),
	};
}

function stepIr(step: NodeBase): Record<string, unknown> {
	return stripUndefined({
		name: step.name,
		node: (step as NodeBase & { node?: string }).node,
		type: (step as NodeBase & { type?: string }).type,
		active: step.active,
		stop: step.stop,
		as: step.as,
		spread: step.spread,
		ephemeral: step.ephemeral,
		flow: step.flow,
	});
}

function nodeConfigIr(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(nodeConfigIr);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return stripUndefined({
		inputs: clone(record.inputs),
		in: record.in,
		as: record.as,
		mode: record.mode,
		concurrency: record.concurrency,
		conditions: Array.isArray(record.conditions)
			? record.conditions.map((condition) => {
					const c = condition as { type: string; condition?: string; steps: NodeBase[] };
					return stripUndefined({
						type: c.type,
						condition: c.condition,
						steps: c.steps.map(stepIr),
					});
				})
			: undefined,
		steps: Array.isArray(record.steps) ? (record.steps as NodeBase[]).map(stepIr) : undefined,
	});
}

function record<T>(ctx: Context, stepName: string, input: unknown, output: T): T {
	const cleanOutput = clone(output);
	((ctx._PRIVATE_ as { trace?: StepTrace[] })?.trace ?? []).push({
		step: stepName,
		input: stripUndefined(clone(input) as Record<string, unknown>),
		output: cleanOutput,
	});
	return cleanOutput as T;
}

function clone<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function quietLogger() {
	return {
		log: () => {},
		logLevel: () => {},
		error: () => {},
		getLogs: () => [],
		getLogsAsText: () => "",
		getLogsAsBase64: () => "",
	};
}
