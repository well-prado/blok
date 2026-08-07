import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

/**
 * #707 — `lowerRefs` must be TOTAL.
 *
 * ADR 0001 Option C keeps the engine byte-identical by compiling structural
 * `{$ref}` handles into the `js/ctx....` wire strings the Mapper already
 * resolves, once, at the load boundary. A site that skips the pass does not
 * fail — the Mapper walks INTO the `{$ref}` object and the node receives
 * `{"$ref": {...}}` where a value belongs. Silent miscompile.
 *
 * The two escapes this file pins:
 *   1. the v1 `nodes` carry-over paths (the bug: every step nested in a
 *      `conditions` arm has its config there);
 *   2. the three resolved-key positions, which were not lowered at all — and,
 *      for `idempotencyKey`, were type-checked BEFORE lowering and therefore
 *      silently DROPPED.
 * Plus the post-normalize invariant that makes a third escape impossible to
 * ship quietly.
 */

const trigger = { http: { method: "POST", path: "/t" } };

describe("#707 — lowerRefs reaches every emitted node config", () => {
	it("lowers a {$ref} nested two levels inside a v1 `conditions` arm", () => {
		const out = normalizeWorkflow(
			{
				name: "V1 Conditions",
				version: "1.0.0",
				trigger,
				steps: [
					{ name: "fetch", node: "@blokjs/api-call", type: "module" },
					{ name: "route", node: "@blokjs/if-else", type: "module" },
				],
				nodes: {
					fetch: { inputs: { url: "https://example.com" } },
					route: {
						conditions: [
							{
								type: "if",
								condition: "ctx.response.data.ok === true",
								steps: [
									{
										name: "inline-inner",
										node: "@blokjs/respond",
										type: "module",
										inputs: { body: { deep: { $ref: { step: "fetch", path: ["data", "id"] } } } },
									},
								],
							},
						],
					},
					// The carry-over case: `deferred-inner` matches NO top-level step,
					// so its config took the verbatim-copy path.
					"deferred-inner": {
						inputs: { body: { $ref: { step: "fetch", path: ["data", "items", 0, "sku"] } } },
					},
				},
			},
			"v1-conditions.json",
		);

		const conditions = out.nodes.route.conditions as Array<{ steps: Array<{ inputs?: Record<string, unknown> }> }>;
		expect(conditions[0].steps[0].inputs).toEqual({ body: { deep: "js/ctx.state.fetch.data.id" } });
		expect(out.nodes["deferred-inner"].inputs).toEqual({ body: "js/ctx.state.fetch.data.items[0].sku" });
	});

	it("lowers the non-`inputs` v1 config keys of a MATCHED step too", () => {
		const out = normalizeWorkflow(
			{
				name: "Matched With Extras",
				version: "1.0.0",
				trigger,
				steps: [{ name: "route", node: "@blokjs/if-else", type: "module" }],
				nodes: {
					route: {
						inputs: { flag: true },
						outputs: { echo: { $ref: { step: "fetch", path: ["data"] } } },
					},
				},
			},
			"matched-extras.json",
		);
		expect(out.nodes.route.outputs).toEqual({ echo: "js/ctx.state.fetch.data" });
	});

	it("leaves a JSON-Schema `$ref` (a STRING target) alone", () => {
		const out = normalizeWorkflow({
			name: "Json Schema",
			version: "1.0.0",
			trigger,
			steps: [
				{
					id: "validate",
					use: "@blokjs/json-validator",
					inputs: { schema: { properties: { addr: { $ref: "#/definitions/Address" } } } },
				},
			],
		});
		expect(out.nodes.validate.inputs).toEqual({
			schema: { properties: { addr: { $ref: "#/definitions/Address" } } },
		});
	});
});

describe("#707 — the three resolved-key positions lower", () => {
	it("lowers a {$ref} step idempotencyKey instead of dropping it", () => {
		const out = normalizeWorkflow({
			name: "Idem",
			version: "1.0.0",
			trigger,
			steps: [
				{
					id: "charge",
					use: "@blokjs/api-call",
					inputs: {},
					idempotencyKey: { $ref: { step: "@trigger", path: ["body", "requestId"] } },
				},
			],
		});
		expect(out.steps[0].idempotencyKey).toBe("js/ctx.request.body.requestId");
	});

	it("lowers a {$ref} idempotencyKey on a sub-workflow step", () => {
		const out = normalizeWorkflow({
			name: "Idem Sub",
			version: "1.0.0",
			trigger,
			steps: [
				{
					id: "child",
					subworkflow: "send-receipt",
					inputs: {},
					idempotencyKey: { $ref: { step: "@trigger", path: ["body", "orderId"] } },
				},
			],
		});
		expect(out.steps[0].idempotencyKey).toBe("js/ctx.request.body.orderId");
	});

	it("lowers trigger concurrencyKey and debounce.key, for any trigger kind", () => {
		const out = normalizeWorkflow({
			name: "Keys",
			version: "1.0.0",
			trigger: {
				http: {
					method: "POST",
					path: "/save",
					concurrencyKey: { $ref: { step: "@trigger", path: ["body", "tenant"] } },
					debounce: { key: { $ref: { step: "@trigger", path: ["params", "docId"] } }, delay: "500ms" },
				},
				worker: { concurrencyKey: { $ref: { step: "@trigger", path: ["body", "queue"] } } },
			},
			steps: [{ id: "a", use: "@blokjs/respond", inputs: {} }],
		});
		const http = out.trigger.http as { concurrencyKey: unknown; debounce: Record<string, unknown> };
		expect(http.concurrencyKey).toBe("js/ctx.request.body.tenant");
		expect(http.debounce.key).toBe("js/ctx.request.params.docId");
		expect(http.debounce.delay).toBe("500ms");
		expect((out.trigger.worker as { concurrencyKey: unknown }).concurrencyKey).toBe("js/ctx.request.body.queue");
	});

	it("leaves a literal key and a `js/` key untouched", () => {
		const out = normalizeWorkflow({
			name: "Literal Keys",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x", concurrencyKey: "global" } },
			steps: [{ id: "a", use: "@blokjs/respond", inputs: {}, idempotencyKey: "js/ctx.request.body.id" }],
		});
		expect((out.trigger.http as { concurrencyKey: unknown }).concurrencyKey).toBe("global");
		expect(out.steps[0].idempotencyKey).toBe("js/ctx.request.body.id");
	});
});

describe("#707 — post-normalize invariant: no structural ref survives", () => {
	/**
	 * `forEach.in` is the deliberately-unlowered fixture: the TS DSL lowers its
	 * handle to a `js/…` string at AUTHORING time and the normalizer passes the
	 * value through verbatim, so a hand-written JSON `{$ref}` there has always
	 * reached ForEachNode as a raw object. Now it is loud at load.
	 */
	it("throws on a {$ref} in forEach.in, naming the step and the path", () => {
		expect(() =>
			normalizeWorkflow(
				{
					name: "Unlowered ForEach",
					version: "1.0.0",
					trigger,
					steps: [
						{
							id: "lines",
							forEach: {
								in: { $ref: { step: "fetch", path: ["items"] } },
								as: "row",
								do: [{ id: "line", use: "@blokjs/respond", inputs: {} }],
							},
						},
					],
				},
				"unlowered-foreach.json",
			),
		).toThrow(/structural `\{\$ref\}` survived normalization at nodes\["lines"\]\.in \(step "lines"\)/);
	});

	it("throws on a {$ref} in switch.on", () => {
		expect(() =>
			normalizeWorkflow({
				name: "Unlowered Switch",
				version: "1.0.0",
				trigger,
				steps: [
					{
						id: "route",
						switch: {
							on: { $ref: { step: "@trigger", path: ["body", "kind"] } },
							cases: [{ when: "a", do: [{ id: "handleA", use: "@blokjs/respond", inputs: {} }] }],
						},
					},
				],
			}),
		).toThrow(/survived normalization at nodes\["route"\]\.on/);
	});

	it("throws on a {$tpl} in a v1 node config the carry-over loop cannot lower", () => {
		expect(() =>
			normalizeWorkflow({
				name: "Unlowered Case When",
				version: "1.0.0",
				trigger,
				steps: [
					{
						id: "route",
						switch: {
							on: "js/ctx.state.fetch.kind",
							cases: [
								{
									when: { $tpl: ["k-", { $ref: { step: "@trigger", path: ["body", "kind"] } }] },
									do: [{ id: "handleA", use: "@blokjs/respond", inputs: {} }],
								},
							],
						},
					},
				],
			}),
		).toThrow(/structural `\{\$tpl\}` survived normalization at nodes\["route"\]\.cases\[0\]\.when/);
	});

	it("does not fire for a workflow whose refs all lower", () => {
		expect(() =>
			normalizeWorkflow({
				name: "Clean",
				version: "1.0.0",
				trigger,
				steps: [
					{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://x" } },
					{
						id: "respond",
						use: "@blokjs/respond",
						inputs: { body: { $tpl: ["id=", { $ref: { step: "fetch", path: ["id"] } }] } },
					},
				],
			}),
		).not.toThrow();
	});
});
