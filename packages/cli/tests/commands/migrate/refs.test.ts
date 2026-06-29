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
		expect(once.value).toContain("// blok-migrate: hand-migrate (dynamic expression)");
		expect(once.value).toContain('d: "js/ctx.state.missing?.value"');
		expect(once.value).toContain('item: { $ref: { step: "item", path: [] } }');
		expect(once.value).toContain('in: "js/ctx.request.body.items"');
		expect(once.value).toContain('idempotencyKey: "js/ctx.request.body.id"');
		expect(once.value).toContain('inputs: { expression: "ctx.state.load.value" }');

		const twice = migrateTsSource(once.value);
		expect(twice.value).toBe(once.value);
		expect(twice.stats).toEqual({ migrated: 0, marked: 0 });
	});
});
