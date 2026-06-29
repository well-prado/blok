import { describe, expect, it } from "vitest";
import { migrateJsonWorkflow, migrateTsSource } from "../../../src/commands/migrate/refs.js";

describe("migrateRefs — JSON workflows", () => {
	it("rewrites only step.inputs pure refs/templates and marks dynamic expressions", () => {
		const input = {
			name: "Refs",
			version: "1.0.0",
			trigger: {
				http: {
					method: "POST",
					path: "/refs",
					concurrencyKey: "js/ctx.request.body.tenantId",
				},
			},
			steps: [
				{ id: "load-history", use: "loader", inputs: {} },
				{
					id: "spread-step",
					use: "splitter",
					spread: true,
					inputs: {},
				},
				{
					id: "next",
					use: "worker",
					idempotencyKey: "js/ctx.request.body.id",
					inputs: {
						a: "$.state['load-history'].value",
						b: "js/ctx.state['load-history'].value",
						c: "js/ctx.request.body.userId",
						d: "js/`user:${ctx.state['load-history'].value}`",
						e: "js/(ctx.state.attempt ?? 0) + 1",
						f: "js/ctx.state['spread-step'].user.name",
						g: "js/ctx.prev.result",
					},
				},
				{
					id: "expr",
					use: "@blokjs/expr",
					inputs: {
						expression: "ctx.state.load.value",
					},
				},
				{
					id: "ephemeral",
					use: "audit",
					ephemeral: true,
					inputs: {},
				},
				{
					id: "after-ephemeral",
					use: "sink",
					inputs: {
						prev: "js/ctx.prev.value",
					},
				},
				{
					id: "loop",
					forEach: {
						in: "js/Array.isArray(ctx.request.body.items) ? ctx.request.body.items : []",
						do: [{ id: "inside", use: "sink", inputs: { item: "js/ctx.state.item" } }],
					},
				},
				{
					id: "switcher",
					switch: {
						on: "js/(ctx.request.headers['x-kind'] || '').toLowerCase()",
						cases: [
							{
								when: "a",
								do: [
									{
										id: "switch-do",
										use: "sink",
										inputs: {
											event: "js/ctx.request.headers['x-event']",
											value: "js/ctx.request.body.value || null",
										},
									},
								],
							},
						],
						default: [{ id: "switch-default", use: "sink", inputs: { body: "js/ctx.request.body" } }],
					},
				},
				{
					id: "dispatch",
					subworkflow: "js/ctx.request.body.type",
					inputs: {
						event: "js/ctx.request.body",
					},
				},
			],
		};

		const once = migrateJsonWorkflow(input);
		const steps = (once.value as typeof input).steps;
		const next = steps[2] as Record<string, Record<string, unknown>>;
		expect(next.inputs.a).toEqual({ $ref: { step: "load-history", path: ["value"] } });
		expect(next.inputs.b).toEqual({ $ref: { step: "load-history", path: ["value"] } });
		expect(next.inputs.c).toEqual({ $ref: { step: "@trigger", path: ["body", "userId"] } });
		expect(next.inputs.d).toEqual({
			$tpl: ["user:", { $ref: { step: "load-history", path: ["value"] } }, ""],
		});
		expect(next.inputs.e).toBe("js/(ctx.state.attempt ?? 0) + 1");
		expect(next.inputs.f).toEqual({ $ref: { step: "user", path: ["name"] } });
		expect(next.inputs.g).toEqual({ $ref: { step: "spread-step", path: ["result"] } });
		expect((next.ui as { notes: string }).notes).toContain("blok-migrate: hand-migrate");
		expect(next.idempotencyKey).toBe("js/ctx.request.body.id");

		const expr = steps[3] as Record<string, Record<string, unknown>>;
		expect(expr.inputs.expression).toBe("ctx.state.load.value");

		const afterEphemeral = steps[5] as Record<string, Record<string, unknown>>;
		expect(afterEphemeral.inputs.prev).toBe("js/ctx.prev.value");
		expect((afterEphemeral.ui as { notes: string }).notes).toContain("blok-migrate: hand-migrate");

		const loop = steps[6] as Record<string, { in: string; do: Array<Record<string, Record<string, unknown>>> }>;
		expect(loop.forEach.in).toBe("js/Array.isArray(ctx.request.body.items) ? ctx.request.body.items : []");
		expect(loop.forEach.do[0].inputs.item).toEqual({ $ref: { step: "item", path: [] } });

		const switcher = steps[7] as Record<
			string,
			{
				on: string;
				cases: Array<{ do: Array<Record<string, Record<string, unknown>>> }>;
				default: Array<Record<string, Record<string, unknown>>>;
			}
		>;
		expect(switcher.switch.on).toBe("js/(ctx.request.headers['x-kind'] || '').toLowerCase()");
		expect(switcher.switch.cases[0].do[0].inputs.event).toEqual({
			$ref: { step: "@trigger", path: ["headers", "x-event"] },
		});
		expect(switcher.switch.cases[0].do[0].inputs.value).toBe("js/ctx.request.body.value || null");
		expect((switcher.switch.cases[0].do[0].ui as { notes: string }).notes).toContain("blok-migrate: hand-migrate");
		expect(switcher.switch.default[0].inputs.body).toEqual({ $ref: { step: "@trigger", path: ["body"] } });

		const dispatch = steps[8] as Record<string, Record<string, unknown>>;
		expect(dispatch.subworkflow).toBe("js/ctx.request.body.type");
		expect(dispatch.inputs.event).toEqual({ $ref: { step: "@trigger", path: ["body"] } });

		const twice = migrateJsonWorkflow(once.value);
		expect(twice.value).toEqual(once.value);
		expect(twice.stats).toEqual({ migrated: 0, marked: 0 });
	});

	it("canonicalizes safe branch.when strings and marks unsafe branch conditions", () => {
		const input = {
			name: "Branches",
			version: "1.0.0",
			trigger: { http: { method: "POST" } },
			steps: [
				{
					id: "method",
					branch: {
						when: 'ctx.req.method === "GET"',
						then: [],
					},
				},
				{
					id: "available",
					branch: {
						when: "ctx.state.stock.inStock === true",
						then: [],
					},
				},
				{
					id: "undefined-check",
					branch: {
						when: "ctx.state.missing === undefined",
						then: [],
					},
				},
				{
					id: "compound",
					branch: {
						when: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined',
						then: [],
					},
				},
				{
					id: "dollar-footgun",
					branch: {
						when: '$.req.method === "GET"',
						then: [],
					},
				},
			],
		};

		const once = migrateJsonWorkflow(input);
		const steps = (once.value as typeof input).steps;
		expect(steps[0].branch.when).toBe('ctx.request.method === "GET"');
		expect(steps[1].branch.when).toBe("ctx.state.stock.inStock");
		expect(steps[2].branch.when).toBe("ctx.state.missing === undefined");
		expect(steps[3].branch.when).toBe(input.steps[3].branch.when);
		expect((steps[3].ui as { notes: string }).notes).toContain("branch.when not handle-safe");
		expect(steps[4].branch.when).toBe(input.steps[4].branch.when);
		expect((steps[4].ui as { notes: string }).notes).toContain("branch.when not handle-safe");
		expect(once.stats).toEqual({ migrated: 2, marked: 2 });

		const twice = migrateJsonWorkflow(once.value);
		expect(twice.value).toEqual(once.value);
		expect(twice.stats).toEqual({ migrated: 0, marked: 0 });
	});
});

describe("migrateRefs — TypeScript workflows", () => {
	it("uses a TS AST walk for step input positions and keeps excluded fields untouched", () => {
		const input = `import { $, workflow } from "@blokjs/helper";

export default workflow({
	name: "Refs",
	version: "1.0.0",
	trigger: {
		http: {
			method: "POST",
			path: "/refs",
			concurrencyKey: "js/ctx.request.body.tenantId",
		},
	},
	steps: [
		{ id: "load-history", use: "loader", inputs: {} },
		{
			id: "next",
			use: "worker",
			idempotencyKey: "js/ctx.request.body.id",
			inputs: {
				a: $.state["load-history"].value,
				b: "js/ctx.state['load-history'].value",
				c: "js/\`user:\${ctx.state['load-history'].value}\`",
				d: "js/ctx.state.missing?.value",
			},
		},
		{
			id: "expr",
			use: "@blokjs/expr",
			inputs: { expression: "ctx.state.load.value" },
		},
		{
			id: "loop",
			forEach: {
				in: "js/ctx.request.body.items",
				do: [{ id: "inside", use: "sink", inputs: { item: "js/ctx.state.item" } }],
			},
		},
	],
});`;

		const once = migrateTsSource(input);
		expect(once.value).toContain('a: { $ref: { step: "load-history", path: ["value"] } }');
		expect(once.value).toContain('b: { $ref: { step: "load-history", path: ["value"] } }');
		expect(once.value).toContain('c: { $tpl: ["user:", { $ref: { step: "load-history", path: ["value"] } }, ""] }');
		expect(once.value).toContain("// blok-migrate: hand-migrate");
		expect(once.value).toContain('d: "js/ctx.state.missing?.value"');
		expect(once.value).toContain('item: { $ref: { step: "item", path: [] } }');
		expect(once.value).toContain('in: "js/ctx.request.body.items"');
		expect(once.value).toContain('idempotencyKey: "js/ctx.request.body.id"');
		expect(once.value).toContain('inputs: { expression: "ctx.state.load.value" }');

		const twice = migrateTsSource(once.value);
		expect(twice.value).toBe(once.value);
		expect(twice.stats).toEqual({ migrated: 0, marked: 0 });
	});

	it("rewrites safe branch.when string literals to helper expressions and marks unsafe whens", () => {
		const input = `import { workflow } from "@blokjs/helper";

export default workflow({
	name: "Branches",
	version: "1.0.0",
	trigger: { http: { method: "POST" } },
	steps: [
		{ id: "method", branch: { when: "ctx.req.method === \\"GET\\"", then: [] } },
		{ id: "available", branch: { when: "ctx.state.stock.inStock === true", then: [] } },
		{ id: "big", branch: { when: "ctx.state.order.total > 10", then: [] } },
		{ id: "missing", branch: { when: "ctx.state.missing === undefined", then: [] } },
		{
			id: "compound",
			branch: {
				when: "ctx.request.method.toLowerCase() === \\"get\\" && ctx.request.params.function === undefined",
				then: [],
			},
		},
		{ id: "dollar-footgun", branch: { when: "$.req.method === \\"GET\\"", then: [] } },
	],
});`;

		const once = migrateTsSource(input);
		expect(once.value).toContain('import { workflow, $, eq, gt } from "@blokjs/helper";');
		expect(once.value).toContain('when: eq($.request.method, "GET")');
		expect(once.value).toContain("when: $.state.stock.inStock");
		expect(once.value).toContain("when: gt($.state.order.total, 10)");
		expect(once.value).toContain("when: eq($.state.missing, undefined)");
		expect(once.value).toContain("// blok-migrate: hand-migrate (dynamic expression / branch.when not handle-safe)");
		expect(once.value).toContain(
			'when: "ctx.request.method.toLowerCase() === \\"get\\" && ctx.request.params.function === undefined"',
		);
		expect(once.value).toContain('when: "$.req.method === \\"GET\\""');
		expect(once.stats).toEqual({ migrated: 4, marked: 2 });

		const twice = migrateTsSource(once.value);
		expect(twice.value).toBe(once.value);
		expect(twice.stats).toEqual({ migrated: 0, marked: 0 });
	});

	it("keeps branch.when truthiness equivalent across the raw-ctx corpus", () => {
		expect(BRANCH_CONTEXTS).toHaveLength(24);
		expect(BRANCH_CONTEXTS.some((ctx) => Number.isNaN((ctx.state.order as { total: number }).total))).toBe(true);

		const jsonInput = branchJsonWorkflow(CONVERTED_WHENS);
		const jsonOutput = migrateJsonWorkflow(jsonInput).value as ReturnType<typeof branchJsonWorkflow>;
		const tsOutput = migrateTsSource(branchTsWorkflow(CONVERTED_WHENS)).value;

		for (const { id, raw } of CONVERTED_WHENS) {
			const jsonWhen = jsonOutput.steps.find((step) => step.id === id)?.branch.when;
			const tsWhen = tsBranchWhen(tsOutput, id);

			for (const ctx of BRANCH_CONTEXTS) {
				expect(evalWhen(String(jsonWhen), ctx), `${id} JSON output diverged for ${raw}`).toEqual(evalWhen(raw, ctx));
				expect(evalWhen(tsWhen, ctx), `${id} TS output diverged for ${raw}`).toEqual(evalWhen(raw, ctx));
			}
		}

		expect(tsBranchWhen(tsOutput, "undefined-literal")).toBe("eq($.request.params.function, undefined)");
		expect(tsBranchWhen(tsOutput, "empty-string-literal")).toBe("eq($.request.params.function, '')");
		expect(tsBranchWhen(tsOutput, "null-literal")).toBe("eq($.state.payload, null)");
	});

	it("leaves branch.when footguns raw and marked", () => {
		const jsonOutput = migrateJsonWorkflow(branchJsonWorkflow(MARKED_WHENS)).value as ReturnType<
			typeof branchJsonWorkflow
		>;
		for (const { id, raw } of MARKED_WHENS) {
			const step = jsonOutput.steps.find((candidate) => candidate.id === id);
			expect(step?.branch.when).toBe(raw);
			expect(step?.ui?.notes).toContain("blok-migrate: hand-migrate");
		}

		const shortCircuit = MARKED_WHENS.find((entry) => entry.id === "short-circuit");
		if (!shortCircuit) throw new Error("missing short-circuit fixture");
		const shortCtx = makeBranchCtx(2);
		shortCtx.state.safe = false;
		shortCtx.state.missing = undefined;
		expect(evalWhen(shortCircuit.raw, shortCtx)).toEqual({ threw: false, truthy: false });
	});
});

const CONVERTED_WHENS = [
	{ id: "countries-vs-facts", raw: 'ctx.request.query.countries === "true"' },
	{ id: "websocket-connect", raw: "ctx.request.body.event === 'connect'" },
	{ id: "request-alias", raw: "ctx.req.method === 'POST'" },
	{ id: "rate-limit", raw: "ctx.state['next-state'].exceeded" },
	{ id: "nested-required", raw: "ctx.state.item.required === true" },
	{ id: "travel-car", raw: "ctx.state['book-car'] !== undefined" },
	{ id: "travel-hotel", raw: "ctx.state['book-hotel'] !== undefined" },
	{ id: "travel-flight", raw: "ctx.state['book-flight'] !== undefined" },
	{ id: "signup-account", raw: "ctx.state['create-account'] !== undefined" },
	{ id: "undefined-literal", raw: "ctx.request.params.function === undefined" },
	{ id: "empty-string-literal", raw: "ctx.request.params.function === ''" },
	{ id: "null-literal", raw: "ctx.state.payload === null" },
	{ id: "zero-strict", raw: "ctx.state.order.total === 0" },
	{ id: "gt-total", raw: "ctx.state.order.total > 100" },
	{ id: "lt-total", raw: "ctx.state.order.total < 1" },
	{ id: "vars-alias", raw: "ctx.vars['choice'] === 'a'" },
	{ id: "prev-alias", raw: "ctx.prev.data.ok === true" },
	{ id: "response-alias", raw: "ctx.response.data.ok === true" },
] as const;

const MARKED_WHENS = [
	{
		id: "dashboard-gen",
		raw: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined',
	},
	{ id: "feedback", raw: 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === ""' },
	{
		id: "admin-only",
		raw: "!ctx.state.identity || !ctx.state.identity.claims || ctx.state.identity.claims.role !== 'admin'",
	},
	{ id: "auth-check", raw: "ctx.state['extract-token'] === '' || ctx.state['extract-token'] !== ctx.state.expected" },
	{ id: "short-circuit", raw: "ctx.state.safe && ctx.state.missing.deep === true" },
	{ id: "dollar-footgun", raw: '$.req.method === "GET"' },
	{ id: "nan-literal", raw: "ctx.state.metric === NaN" },
] as const;

const BRANCH_CONTEXTS = Array.from({ length: 24 }, (_, i) => makeBranchCtx(i));

function branchJsonWorkflow(entries: readonly { id: string; raw: string }[]) {
	return {
		name: "branch corpus",
		version: "1.0.0",
		steps: entries.map(({ id, raw }) => ({ id, branch: { when: raw, then: [] as unknown[] } })),
	};
}

function branchTsWorkflow(entries: readonly { id: string; raw: string }[]): string {
	const steps = entries
		.map(({ id, raw }) => `\t\t{ id: ${JSON.stringify(id)}, branch: { when: ${JSON.stringify(raw)}, then: [] } },`)
		.join("\n");
	return `import { workflow } from "@blokjs/helper";

export default workflow({
\tname: "branch corpus",
\tversion: "1.0.0",
\tsteps: [
${steps}
\t],
});`;
}

function tsBranchWhen(source: string, id: string): string {
	const start = source.indexOf(`id: ${JSON.stringify(id)}`);
	if (start < 0) throw new Error(`missing branch step ${id}`);
	const whenStart = source.indexOf("when:", start);
	const thenStart = source.indexOf(", then:", whenStart);
	if (whenStart < 0 || thenStart < 0) throw new Error(`missing branch.when for ${id}`);
	return source.slice(whenStart + "when:".length, thenStart).trim();
}

function makeBranchCtx(i: number) {
	const totals = [0, 1, 10, 100, 101, Number.NaN];
	const params = [undefined, "", null, "show", 0, false];
	const state: Record<string, unknown> = {
		item: { required: i % 3 === 0 },
		metric: [Number.NaN, 0, "", null][i % 4],
		order: { total: totals[i % totals.length] },
		payload: [null, "", 0, Number.NaN, { ok: true }][i % 5],
		safe: i % 2 === 0,
		"next-state": { exceeded: i % 5 === 0 },
		"extract-token": i % 2 === 0 ? "" : "token",
		expected: i % 3 === 0 ? "token" : "other",
		choice: i % 4 === 0 ? "a" : "b",
	};
	if (i % 2 === 0) state["book-car"] = { id: i };
	if (i % 3 === 0) state["book-hotel"] = { id: i };
	if (i % 4 === 0) state["book-flight"] = { id: i };
	if (i % 5 === 0) state["create-account"] = { id: i };
	const response = { data: { ok: i % 2 === 0 } };
	const request = {
		method: ["GET", "POST", "get", "DELETE"][i % 4],
		query: { countries: i % 2 === 0 ? "true" : i % 3 === 0 ? true : "false" },
		body: { event: ["connect", "message", "", null][i % 4] },
		params: { function: params[i % params.length] },
		headers: {},
	};
	return {
		request,
		req: request,
		response,
		prev: response,
		state,
		vars: state,
	};
}

function evalWhen(expr: string, ctx: ReturnType<typeof makeBranchCtx>): { threw: boolean; truthy?: boolean } {
	try {
		const handle = { request: ctx.request, req: ctx.request, state: ctx.state, vars: ctx.state, prev: ctx.response };
		const result = Function(
			"ctx",
			"$",
			"eq",
			"ne",
			"gt",
			"gte",
			"lt",
			"lte",
			`"use strict"; return (${expr});`,
		)(ctx, handle, strictEq, strictNe, gt, gte, lt, lte);
		return { threw: false, truthy: Boolean(result) };
	} catch {
		return { threw: true };
	}
}

function strictEq(left: unknown, right: unknown): boolean {
	return left === right;
}

function strictNe(left: unknown, right: unknown): boolean {
	return left !== right;
}

function gt(left: unknown, right: unknown): boolean {
	return (left as number) > (right as number);
}

function gte(left: unknown, right: unknown): boolean {
	return (left as number) >= (right as number);
}

function lt(left: unknown, right: unknown): boolean {
	return (left as number) < (right as number);
}

function lte(left: unknown, right: unknown): boolean {
	return (left as number) <= (right as number);
}
