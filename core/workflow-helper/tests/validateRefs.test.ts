import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { type CatalogNodeLike, nodeSchemaLookup, validateRefs } from "../src/validateRefs";

// #691 — schema-aware `$ref` checking. Every cross-step read is validated
// against the DECLARED OUTPUT SCHEMA of the producing step's node.

function schemaOf(shape: z.ZodTypeAny): unknown {
	return zodToJsonSchema(shape, { target: "jsonSchema7", $refStrategy: "none" });
}

function lookup(entries: Record<string, z.ZodTypeAny | unknown>): ReturnType<typeof nodeSchemaLookup> {
	const catalog: CatalogNodeLike[] = Object.entries(entries).map(([ref, value]) => ({
		ref,
		name: ref,
		outputSchema: value instanceof z.ZodType ? schemaOf(value) : value,
	}));
	return nodeSchemaLookup(catalog);
}

const codes = (result: ReturnType<typeof validateRefs>) => result.diagnostics.map((d) => d.code);
const errors = (result: ReturnType<typeof validateRefs>) => result.diagnostics.filter((d) => d.severity === "error");

// ─────────────────────── the field report's exact bug ───────────────────────

describe("validateRefs — the field-report scenario", () => {
	const workflow = {
		name: "tetrix-blok-repro",
		version: "1.0.0",
		trigger: { http: { method: "POST", path: "/ingest" } },
		steps: [
			{ id: "project", use: "projector", inputs: { event: "x" } },
			{
				id: "respond",
				use: "@blokjs/respond",
				inputs: { body: { served: { $ref: { step: "project", path: ["readModelServed"] } } } },
			},
		],
	};

	it("errors when the ref names a field the node's output schema does not declare", () => {
		const result = validateRefs(workflow, {
			nodes: lookup({
				projector: z.object({ eventsApplied: z.number(), lastSeq: z.number() }),
				"@blokjs/respond": z.object({ ok: z.boolean() }),
			}),
		});

		expect(result.ok).toBe(false);
		const bad = errors(result);
		expect(bad).toHaveLength(1);
		expect(bad[0]?.code).toBe("unknown-field");
		expect(bad[0]?.step).toBe("respond");
		expect(bad[0]?.producer).toBe("project");
		expect(bad[0]?.refPath).toBe("readModelServed");
		// The producer's declared field list is part of the message — that IS the
		// fix instruction.
		expect(bad[0]?.fields).toEqual(["eventsApplied", "lastSeq"]);
		expect(bad[0]?.message).toContain("readModelServed");
		expect(bad[0]?.message).toContain("eventsApplied, lastSeq");
	});

	it("passes once the field is added to the node's output schema", () => {
		const result = validateRefs(workflow, {
			nodes: lookup({
				projector: z.object({ eventsApplied: z.number(), lastSeq: z.number(), readModelServed: z.boolean() }),
				"@blokjs/respond": z.object({ ok: z.boolean() }),
			}),
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
	});
});

// ───────────────────────────── root-level errors ────────────────────────────

describe("validateRefs — dangling / ephemeral / arm escape", () => {
	it("reports a dangling step naming reader and missing producer", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "a", use: "n", inputs: {} },
					{ id: "b", use: "n", inputs: { x: { $ref: { step: "typo", path: ["y"] } } } },
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(codes(result)).toEqual(["dangling-step"]);
		expect(result.diagnostics[0]?.message).toContain('Step "b"');
		expect(result.diagnostics[0]?.message).toContain("`typo`");
		expect(result.diagnostics[0]?.path).toBe("steps[1].inputs.x");
	});

	it("reports a read of an `ephemeral: true` producer", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "log", use: "n", ephemeral: true },
					{ id: "b", use: "n", inputs: { x: { $ref: { step: "log", path: ["y"] } } } },
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(codes(result)).toEqual(["ephemeral-read"]);
		expect(result.diagnostics[0]?.message).toContain("ephemeral: true");
	});

	it("reports a read of a `spread: true` step's own id", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "load", use: "n", spread: true },
					{ id: "b", use: "n", inputs: { x: { $ref: { step: "load", path: [] } } } },
				],
			},
			{ nodes: lookup({ n: z.object({ user: z.object({ id: z.string() }) }) }) },
		);
		expect(codes(result)).toEqual(["dangling-step"]);
		expect(result.diagnostics[0]?.message).toContain("spread: true");
	});

	it("errors when producer and reader sit in mutually exclusive branch arms", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{
						id: "route",
						branch: {
							when: "ctx.request.body.kind === 'a'",
							then: [{ id: "mkA", use: "n", inputs: {} }],
							else: [{ id: "useA", use: "n", inputs: { x: { $ref: { step: "mkA", path: ["y"] } } } }],
						},
					},
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(codes(result)).toEqual(["arm-escape"]);
		expect(result.diagnostics[0]?.message).toContain("mutually exclusive");
	});

	it("errors across two switch cases", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{
						id: "route",
						switch: {
							on: "js/ctx.request.body.kind",
							cases: [
								{ when: "a", do: [{ id: "mkA", use: "n", inputs: {} }] },
								{ when: "b", do: [{ id: "useA", use: "n", inputs: { x: { $ref: { step: "mkA", path: [] } } } }] },
							],
						},
					},
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(codes(result)).toEqual(["arm-escape"]);
	});

	it("does NOT flag a tryCatch `catch` arm reading a `try` step — the saga pattern", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{
						id: "saga",
						tryCatch: {
							try: [{ id: "create", use: "n", inputs: {} }],
							catch: [{ id: "rollback", use: "n", inputs: { id: { $ref: { step: "create", path: ["y"] } } } }],
						},
					},
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(result.diagnostics).toEqual([]);
	});

	it("does NOT flag a read AFTER the branch — state is one flat object at run time", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "route", branch: { when: "ctx.request.body.x", then: [{ id: "mkA", use: "n", inputs: {} }] } },
					{ id: "after", use: "n", inputs: { x: { $ref: { step: "mkA", path: ["y"] } } } },
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(result.diagnostics).toEqual([]);
	});

	it("accepts a read when BOTH arms write the same `as` key", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{
						id: "route",
						branch: {
							when: "ctx.request.body.x",
							then: [{ id: "mkA", use: "n", as: "result", inputs: {} }],
							else: [{ id: "mkB", use: "n", as: "result", inputs: {} }],
						},
					},
					{ id: "after", use: "n", inputs: { x: { $ref: { step: "result", path: ["y"] } } } },
				],
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(result.diagnostics).toEqual([]);
	});
});

// ───────────────────────────── schema-walk semantics ────────────────────────

describe("validateRefs — schema walk", () => {
	const wf = (inputs: Record<string, unknown>) => ({
		name: "wf",
		steps: [
			{ id: "src", use: "producer", inputs: {} },
			{ id: "sink", use: "consumer", inputs },
		],
	});

	const producer = z.object({
		title: z.string(),
		optional: z.string().optional(),
		nested: z.object({ deep: z.string() }),
		rows: z.array(z.object({ sku: z.string() })),
		either: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
		bag: z.record(z.string(), z.unknown()),
		open: z.object({ known: z.string() }).passthrough(),
	});
	const nodes = lookup({ producer, consumer: z.object({ ok: z.boolean() }) });

	const ref = (...path: (string | number)[]) => ({ $ref: { step: "src", path } });

	it("accepts a declared field, an optional field, and a nested field", () => {
		const result = validateRefs(wf({ a: ref("title"), b: ref("optional"), c: ref("nested", "deep") }), { nodes });
		expect(result.diagnostics).toEqual([]);
	});

	it("accepts an array index walk and rejects an unknown field under it", () => {
		expect(validateRefs(wf({ a: ref("rows", 0, "sku") }), { nodes }).diagnostics).toEqual([]);
		expect(codes(validateRefs(wf({ a: ref("rows", 0, "nope") }), { nodes }))).toEqual(["unknown-field"]);
	});

	it("accepts a union field valid in ANY branch and merges both field lists on failure", () => {
		expect(validateRefs(wf({ a: ref("either", "a") }), { nodes }).diagnostics).toEqual([]);
		expect(validateRefs(wf({ a: ref("either", "b") }), { nodes }).diagnostics).toEqual([]);
		const bad = errors(validateRefs(wf({ a: ref("either", "c") }), { nodes }));
		expect(bad[0]?.code).toBe("unknown-field");
		expect(bad[0]?.fields).toEqual(["a", "b"]);
	});

	it("stays silent inside a free-form record — absence is unprovable there", () => {
		expect(validateRefs(wf({ a: ref("bag", "anything") }), { nodes }).diagnostics).toEqual([]);
	});

	it("warns (never errors) under an open `additionalProperties` object", () => {
		const result = validateRefs(wf({ a: ref("open", "surprise") }), { nodes });
		expect(codes(result)).toEqual(["unprovable-field"]);
		expect(result.ok).toBe(true);
	});

	it("stays silent on JS members of arrays and scalars (`.length`, `.map`)", () => {
		expect(validateRefs(wf({ a: ref("rows", "length"), b: ref("title", "length") }), { nodes }).diagnostics).toEqual(
			[],
		);
	});

	it("errors on an unknown top-level field, naming the declared field list", () => {
		const bad = errors(validateRefs(wf({ a: ref("titel") }), { nodes }));
		expect(bad[0]?.code).toBe("unknown-field");
		expect(bad[0]?.fields).toContain("title");
	});
});

// ─────────────────────── persistence knobs: as / spread ─────────────────────

describe("validateRefs — `as` and `spread` resolution", () => {
	it("resolves a ref through the `as:` state key, not the step id", () => {
		const doc = (root: string) => ({
			name: "wf",
			steps: [
				{ id: "step-1", use: "n", as: "users", inputs: {} },
				{ id: "b", use: "n", inputs: { x: { $ref: { step: root, path: ["y"] } } } },
			],
		});
		const nodes = lookup({ n: z.object({ y: z.string() }) });
		expect(validateRefs(doc("users"), { nodes }).diagnostics).toEqual([]);
		// The step id is NOT a slot once `as:` is set.
		expect(codes(validateRefs(doc("step-1"), { nodes }))).toEqual(["dangling-step"]);
	});

	it("resolves per-key refs of a `spread: true` step against the key's sub-schema", () => {
		const nodes = lookup({
			loader: z.object({ user: z.object({ id: z.string() }), profile: z.object({ bio: z.string() }) }),
			n: z.object({ y: z.string() }),
		});
		const doc = (path: string[]) => ({
			name: "wf",
			steps: [
				{ id: "load", use: "loader", spread: true },
				{ id: "b", use: "n", inputs: { x: { $ref: { step: "user", path } } } },
			],
		});
		expect(validateRefs(doc(["id"]), { nodes }).diagnostics).toEqual([]);
		expect(codes(validateRefs(doc(["nope"]), { nodes }))).toEqual(["unknown-field"]);
	});
});

// ─────────────────────────────── forEach keys ───────────────────────────────

describe("validateRefs — forEach `as` / `asIndex` share the step-id namespace", () => {
	const nodes = lookup({ n: z.object({ y: z.string() }), src: z.object({ items: z.array(z.string()) }) });

	it("accepts reads of the loop variable and its index from inside the body", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "src", use: "src", inputs: {} },
					{
						id: "itemsResults",
						forEach: {
							in: "js/ctx.state.src.items",
							as: "item",
							do: [{ id: "save", use: "n", inputs: { v: "js/ctx.state.item", i: "js/ctx.state.itemIndex" } }],
						},
					},
				],
			},
			{ nodes },
		);
		expect(result.diagnostics).toEqual([]);
	});

	it("accepts a read of the loop's results array after the loop", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "src", use: "src", inputs: {} },
					{
						id: "itemsResults",
						forEach: { in: "js/ctx.state.src.items", as: "item", do: [{ id: "save", use: "n", inputs: {} }] },
					},
					{ id: "after", use: "n", inputs: { n: "js/ctx.state.itemsResults.length" } },
				],
			},
			{ nodes },
		);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports an unknown field on the forEach source", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "src", use: "src", inputs: {} },
					{
						id: "r",
						forEach: { in: "js/ctx.state.src.itemz", as: "item", do: [{ id: "save", use: "n", inputs: {} }] },
					},
				],
			},
			{ nodes },
		);
		expect(codes(result)).toEqual(["unknown-field"]);
		expect(result.diagnostics[0]?.path).toBe("steps[1].forEach.in");
	});
});

// ────────────────────── wire strings, templates, tpl ────────────────────────

describe("validateRefs — wire-string and template sites", () => {
	const nodes = lookup({ n: z.object({ y: z.string(), rows: z.array(z.object({ sku: z.string() })) }) });
	const withSecond = (second: Record<string, unknown>) => ({
		name: "wf",
		steps: [
			{ id: "a", use: "n", inputs: {} },
			{ id: "b", use: "n", ...second },
		],
	});

	it("checks a `js/ctx.state...` string input", () => {
		expect(codes(validateRefs(withSecond({ inputs: { x: "js/ctx.state.a.nope" } }), { nodes }))).toEqual([
			"unknown-field",
		]);
		expect(validateRefs(withSecond({ inputs: { x: "js/ctx.state.a.y" } }), { nodes }).diagnostics).toEqual([]);
	});

	it("checks a `${...}` interpolation inside a plain string", () => {
		expect(codes(validateRefs(withSecond({ inputs: { x: "hello ${ctx.state.a.nope}!" } }), { nodes }))).toEqual([
			"unknown-field",
		]);
	});

	it("checks the operands of a bare-ctx `branch.when`", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "a", use: "n", inputs: {} },
					{ id: "r", branch: { when: 'ctx.state.a.nope === "x"', then: [{ id: "t", use: "n", inputs: {} }] } },
				],
			},
			{ nodes },
		);
		expect(codes(result)).toEqual(["unknown-field"]);
		expect(result.diagnostics[0]?.path).toBe("steps[1].branch.when");
	});

	it("checks a `{$tpl}` segment", () => {
		const result = validateRefs(
			withSecond({ inputs: { line: { $tpl: ["order ", { $ref: { step: "a", path: ["nope"] } }] } } }),
			{ nodes },
		);
		expect(codes(result)).toEqual(["unknown-field"]);
		expect(result.diagnostics[0]?.path).toBe("steps[1].inputs.line.$tpl[1]");
	});

	it("checks an `idempotencyKey` expression", () => {
		expect(codes(validateRefs(withSecond({ idempotencyKey: "js/ctx.state.a.nope" }), { nodes }))).toEqual([
			"unknown-field",
		]);
	});

	it("stays quiet on method calls, dynamic indexes and fallbacks", () => {
		const quiet = withSecond({
			inputs: {
				a: "js/(ctx.state.a.rows || []).map(r => r.sku)",
				b: "js/ctx.state.a[key].whatever",
				c: "js/Object.keys(ctx.state)",
				d: "js/ctx.state.a.rows.filter(Boolean).length",
			},
		});
		expect(validateRefs(quiet, { nodes }).diagnostics).toEqual([]);
	});

	it("ignores `ctx.state` mentioned in free-text fields", () => {
		const doc = withSecond({ ui: { notes: "reads ctx.state.nothing.here" }, description: "ctx.state.also.not" });
		expect(validateRefs(doc, { nodes }).diagnostics).toEqual([]);
	});

	it("ignores trigger and error roots — neither is a step", () => {
		const doc = withSecond({
			inputs: {
				a: { $ref: { step: "@trigger", path: ["body", "name"] } },
				b: { $ref: { step: "@error", path: ["message"] } },
				c: "js/ctx.request.body.name",
			},
		});
		expect(validateRefs(doc, { nodes }).diagnostics).toEqual([]);
	});
});

// ──────────────────────────── graceful degradation ──────────────────────────

describe("validateRefs — graceful degradation", () => {
	it("never errors on a field when the producing node advertises no schema", () => {
		const result = validateRefs(
			{
				name: "wf",
				steps: [
					{ id: "a", use: "mystery", inputs: {} },
					{ id: "b", use: "mystery", inputs: { x: { $ref: { step: "a", path: ["whatever"] } } } },
				],
			},
			{ nodes: lookup({}) },
		);
		expect(result.ok).toBe(true);
		expect(codes(result)).toEqual(["unchecked-node"]);
		expect(result.uncheckedSteps).toEqual(["a", "b"]);
	});

	it("validates a workflow of only unchecked steps clean, with the unchecked summary", () => {
		const result = validateRefs({
			name: "wf",
			steps: [
				{ id: "a", use: "mystery", inputs: {} },
				{ id: "b", use: "mystery", inputs: { x: "js/ctx.state.a.whatever" } },
			],
		});
		expect(result.ok).toBe(true);
		expect(errors(result)).toEqual([]);
		expect(result.uncheckedSteps).toEqual(["a", "b"]);
	});

	it("still reports root-level problems on unchecked steps — those need no schema", () => {
		const result = validateRefs({
			name: "wf",
			steps: [
				{ id: "a", use: "mystery", ephemeral: true },
				{ id: "b", use: "mystery", inputs: { x: "js/ctx.state.a.y", z: "js/ctx.state.gone" } },
			],
		});
		expect(codes(result).sort()).toEqual(["dangling-step", "ephemeral-read"]);
	});

	it("downgrades dangling roots to warnings when middleware can write foreign state", () => {
		const result = validateRefs({
			name: "wf",
			trigger: { http: { method: "GET", path: "/x", middleware: ["auth"] } },
			steps: [{ id: "b", use: "mystery", inputs: { x: "js/ctx.state.session.userId" } }],
		});
		expect(result.ok).toBe(true);
		expect(codes(result)).toEqual(["dangling-step"]);
		expect(result.diagnostics[0]?.severity).toBe("warning");
	});

	it("returns clean for non-workflow input", () => {
		expect(validateRefs(null).diagnostics).toEqual([]);
		expect(validateRefs({ name: "no steps" }).ok).toBe(true);
	});

	it("unwraps a TS builder envelope", () => {
		const result = validateRefs(
			{
				_blokV2: true,
				_config: { name: "wf", steps: [{ id: "b", use: "n", inputs: { x: { $ref: { step: "gone", path: [] } } } }] },
			},
			{ nodes: lookup({ n: z.object({ y: z.string() }) }) },
		);
		expect(codes(result)).toEqual(["dangling-step"]);
	});
});

// ─────────────── ctx-publish slots — scoped AND bare node refs ───────────────
//
// The runner's canonical node-key rule (ADR 0002) resolves `ctx-publish` and
// `@blokjs/ctx-publish` to the same node, and the shipped corpus uses BOTH
// forms (`examples/v05-primitives/09-polling-with-backoff.json` publishes
// `attempt` via bare `ctx-publish`). Regression: matching only the scoped form
// produced 8 false dangling-step errors on the integration merge with #690's
// corpus migration — the migration turned dollar-prefixed state strings this pass could
// not parse into structural refs it suddenly could.

describe("validateRefs — published slots resolve for scoped and bare refs", () => {
	const flow = (publishRef: string, manyRef: string) => ({
		name: "publish-forms",
		version: "1.0.0",
		trigger: { http: { method: "POST", path: "/p" } },
		steps: [
			{ id: "init", use: publishRef, inputs: { name: "attempt", value: 0 } },
			{ id: "seed", use: manyRef, inputs: { values: { lastStatus: "pending" } } },
			{
				id: "respond",
				use: "@blokjs/respond",
				inputs: {
					body: {
						n: { $ref: { step: "attempt", path: [] } },
						s: { $ref: { step: "lastStatus", path: [] } },
					},
				},
			},
		],
	});

	it("bare `ctx-publish` / `ctx-publish-many` refs register their slots (no dangling-step)", () => {
		const result = validateRefs(flow("ctx-publish", "ctx-publish-many"), { nodes: lookup({}) });
		expect(errors(result)).toEqual([]);
	});

	it("scoped `@blokjs/ctx-publish[-many]` refs register their slots (no dangling-step)", () => {
		const result = validateRefs(flow("@blokjs/ctx-publish", "@blokjs/ctx-publish-many"), { nodes: lookup({}) });
		expect(errors(result)).toEqual([]);
	});

	it("an unrelated bare ref does NOT register a slot — dangling still fires", () => {
		const result = validateRefs(flow("some-other-node", "ctx-publish-many"), { nodes: lookup({}) });
		expect(codes(result)).toContain("dangling-step");
	});
});

// ────────────── resolved-key fields: idempotency / concurrency (#706) ───────
//
// The runner resolves these with a `js/`-or-LITERAL rule, so an expression it
// does not recognise becomes a CONSTANT key — one idempotency-cache entry
// replayed to every caller for 24h, or one concurrency bucket for every tenant.
// The shipped `v06-reliability-showcase` workflow had exactly this, in the
// workflow whose stated purpose was demonstrating the reliability primitives.

describe("validateRefs — resolved-key fields (#706)", () => {
	const flow = (over: { idem?: unknown; conc?: unknown; debounceKey?: unknown }) => ({
		name: "v06-reliability-showcase",
		version: "1.0.0",
		trigger: {
			http: {
				method: "POST",
				path: "/orders",
				...(over.conc !== undefined ? { concurrencyKey: over.conc } : {}),
				...(over.debounceKey !== undefined ? { debounce: { key: over.debounceKey, delay: "500ms" } } : {}),
			},
		},
		steps: [
			{ id: "charge", use: "charger", inputs: {}, ...(over.idem !== undefined ? { idempotencyKey: over.idem } : {}) },
		],
	});

	it("flags an expression-shaped step idempotencyKey", () => {
		const result = validateRefs(flow({ idem: "$.req.body.requestId" }), { nodes: lookup({}) });
		const bad = errors(result);
		expect(bad).toHaveLength(1);
		expect(bad[0]?.code).toBe("unresolvable-key");
		expect(bad[0]?.path).toBe("steps[0].idempotencyKey");
		expect(bad[0]?.step).toBe("charge");
		expect(bad[0]?.message).toContain("idempotencyKey");
		expect(bad[0]?.message).toContain("js/");
	});

	it("flags an expression-shaped trigger concurrencyKey", () => {
		const result = validateRefs(flow({ conc: "$.req.body.tenant" }), { nodes: lookup({}) });
		const bad = errors(result);
		expect(bad).toHaveLength(1);
		expect(bad[0]?.code).toBe("unresolvable-key");
		expect(bad[0]?.path).toBe("trigger.http.concurrencyKey");
		expect(bad[0]?.step).toBe("<trigger>");
	});

	it("flags an expression-shaped trigger debounce.key", () => {
		const result = validateRefs(flow({ debounceKey: "ctx.request.params.docId" }), { nodes: lookup({}) });
		expect(errors(result).map((d) => d.path)).toEqual(["trigger.http.debounce.key"]);
	});

	it("flags `${…}` and `{{…}}` forms, and an unlowered {$ref} object", () => {
		expect(codes(validateRefs(flow({ idem: "order-${ctx.request.body.id}" }), { nodes: lookup({}) }))).toContain(
			"unresolvable-key",
		);
		expect(codes(validateRefs(flow({ idem: "{{requestId}}" }), { nodes: lookup({}) }))).toContain("unresolvable-key");
		// `lowerRefs` runs over step `inputs` only — a structural ref here never
		// becomes a `js/` string, so it reaches the runner raw.
		const structural = validateRefs(flow({ idem: { $ref: { step: "@trigger", path: ["body", "requestId"] } } }), {
			nodes: lookup({}),
		});
		expect(codes(structural)).toContain("unresolvable-key");
	});

	it("finds the field inside a nested control-flow arm", () => {
		const result = validateRefs(
			{
				name: "nested",
				version: "1.0.0",
				trigger: { http: { method: "POST", path: "/n" } },
				steps: [
					{
						id: "guard",
						branch: {
							when: "ctx.request.body.big",
							then: [{ id: "charge", use: "charger", inputs: {}, idempotencyKey: "$.req.body.requestId" }],
						},
					},
				],
			},
			{ nodes: lookup({}) },
		);
		expect(errors(result).map((d) => d.code)).toEqual(["unresolvable-key"]);
	});

	it("stays silent on `js/` expressions and on deliberate literals", () => {
		const ok = validateRefs(
			flow({
				idem: "js/ctx.request.body.requestId",
				conc: "js/ctx.request.body.tenant",
				debounceKey: "nightly-report",
			}),
			{ nodes: lookup({}) },
		);
		expect(ok.diagnostics).toEqual([]);
		expect(ok.ok).toBe(true);
	});
});
