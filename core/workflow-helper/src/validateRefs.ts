/**
 * validateRefs — schema-aware step-output reference checking (#691).
 *
 * Every cross-step read in a workflow IR is checked against the DECLARED OUTPUT
 * SCHEMA of the step that produces it, BEFORE the workflow ever runs. This is
 * the static half of {@link NamedMissingStateError} (#345): the runtime backstop
 * catches a dangling read when it blows up; this pass catches it at
 * `blokctl check` / Studio edit / boot time.
 *
 * TypeScript already protects the typed-handle authoring surface. This pass
 * exists for everything `tsc` cannot see: JSON workflows, Studio-authored
 * workflows, AI-generated workflows.
 *
 * **Zero dependencies on purpose.** It walks plain objects only — no Zod, no
 * runner. That is what lets the CLI, the runner's boot path, AND the Studio
 * browser bundle share ONE implementation without dragging the Zod schema graph
 * into the browser (ADR 0011's actual constraint).
 *
 * ## What it reads
 *
 * Two reference syntaxes coexist in the IR and both are checked:
 *
 * 1. **Structural** `{$ref: {step, path}}` / `{$tpl: [...]}` (ADR 0001 Option C)
 *    — machine-checkable without parsing JS, so these get the FULL schema walk.
 * 2. **Wire strings** — `js/ctx.state.<id>.<field>`, `${ctx.state...}`
 *    interpolations, and the bare-ctx `branch.when` / `loop.while` forms.
 *    Each `ctx.state…` member chain inside the expression is read as far as it
 *    is STATICALLY provable and then truncated: a dynamic index
 *    (`ctx.state.a[k].b`) or a method call (`ctx.state.rows.filter(…)`) ends
 *    the chain. Truncation checks less, it never invents a field — which is
 *    what keeps the pass quiet on real JS, and a noisy validator gets switched
 *    off.
 *    // ponytail: regex member-chain scan, not a JS parser. Upgrade path if a
 *    // consumer needs reads through ternaries/destructuring: parse the
 *    // expression and walk the real member-expression AST.
 *
 * ## Graceful degradation (hard requirement)
 *
 * A step whose node advertises no output schema is **unchecked**: its reads
 * never produce a field error, they produce at most a deduped warning, and the
 * step is listed in {@link ValidateRefsResult.uncheckedSteps} so a report can
 * end with "N steps unchecked". Root-level problems (dangling / ephemeral /
 * arm escape) do NOT need a schema and stay errors.
 */

import type { StructuralRef } from "./refSyntax";
import {
	ERROR_SENTINEL,
	TRIGGER_SENTINEL,
	isStructuralRef,
	isStructuralTpl,
	parseCtxExpression,
	renderRefPath,
} from "./refSyntax";

// ─────────────────────────────── public types ───────────────────────────────

export type RefSeverity = "error" | "warning";

/**
 * - `dangling-step` — no step in the workflow writes that state key.
 * - `ephemeral-read` — the producer declares `ephemeral: true`; its handle is
 *   unreadable (footgun #2).
 * - `arm-escape` — producer and reader sit in mutually exclusive control-flow
 *   arms, so the read can never see a value (footgun #1).
 * - `unknown-field` — the field is absent from the producer's declared output
 *   schema and the schema is closed (`additionalProperties: false`).
 * - `unprovable-field` — the field is absent from `properties` but the schema
 *   is open (`additionalProperties` true / a sub-schema), so absence cannot be
 *   proven. Warning.
 * - `unchecked-node` — the producing node advertises no output schema, so the
 *   field cannot be checked at all. Warning.
 */
export type RefDiagnosticCode =
	| "dangling-step"
	| "ephemeral-read"
	| "arm-escape"
	| "unknown-field"
	| "unprovable-field"
	| "unchecked-node";

export interface RefDiagnostic {
	readonly severity: RefSeverity;
	readonly code: RefDiagnosticCode;
	/** Dot/bracket location of the offending value inside the document. */
	readonly path: string;
	/** Id of the step doing the reading (`"<trigger>"` when outside any step). */
	readonly step: string;
	/** State key being read (the producing step's `as ?? id`). */
	readonly producer: string;
	/** Field path under the producer, rendered (`data.readModelServed`). */
	readonly refPath: string;
	/** The producer's declared top-level field names, when known. */
	readonly fields?: readonly string[];
	readonly message: string;
}

export interface ValidateRefsResult {
	/** True when there is no `severity: "error"` diagnostic. */
	readonly ok: boolean;
	readonly diagnostics: readonly RefDiagnostic[];
	/** Step ids whose node advertised no output schema (sorted, deduped). */
	readonly uncheckedSteps: readonly string[];
}

/**
 * Resolves a step's `use` (node ref) to that node's output JSON Schema.
 *
 * Return `undefined` when the node is unknown or advertises no schema — the
 * step is then "unchecked". Return the parsed JSON Schema otherwise. Build one
 * from `GET /__blok/nodes` with {@link nodeSchemaLookup}.
 */
export type NodeSchemaLookup = (use: string) => unknown;

export interface ValidateRefsOptions {
	/** Node ref → output JSON Schema. Omitted ⇒ every step is unchecked. */
	readonly nodes?: NodeSchemaLookup;
	/** Workflow name for messages. Read from the document when omitted. */
	readonly workflowName?: string;
	/**
	 * State keys written from OUTSIDE this document, which therefore must not be
	 * reported as dangling. Two real sources:
	 *
	 * - **middleware** — a `middleware: true` workflow runs on the PARENT ctx, so
	 *   whatever it writes is readable by every workflow it guards (declared per
	 *   workflow, per trigger, or process-globally via `BLOK_GLOBAL_MIDDLEWARE`,
	 *   which is invisible in the guarded document). Build this with
	 *   {@link middlewareStateKeys} over the project's workflows.
	 * - **`ctx.publish(name, …)`** inside a custom node's `execute()`, which no
	 *   static pass can see.
	 */
	readonly knownStateKeys?: Iterable<string>;
}

/** One entry of a node catalog (`GET /__blok/nodes`) — structurally typed. */
export interface CatalogNodeLike {
	readonly name?: string;
	readonly ref?: string;
	readonly outputSchema?: unknown;
}

/**
 * Build a {@link NodeSchemaLookup} from a node catalog. Keys on both `ref` (the
 * exact resolvable `use` string) and `name`, because JSON workflows are written
 * against either. A null/empty schema is treated as "no schema advertised".
 */
export function nodeSchemaLookup(nodes: readonly CatalogNodeLike[]): NodeSchemaLookup {
	const byKey = new Map<string, unknown>();
	for (const node of nodes) {
		const schema = node.outputSchema;
		if (!isPlainObject(schema) || Object.keys(schema).length === 0) continue;
		if (typeof node.ref === "string") byKey.set(node.ref, schema);
		// `name` is the fallback key — never overwrite an exact `ref` match.
		if (typeof node.name === "string" && !byKey.has(node.name)) byKey.set(node.name, schema);
	}
	return (use: string) => byKey.get(use);
}

/**
 * Collect the state keys every MIDDLEWARE workflow in a project writes.
 *
 * A `middleware: true` workflow runs on the guarded workflow's ctx, so its
 * state keys are readable from any workflow it fronts — including via
 * `BLOK_GLOBAL_MIDDLEWARE`, which leaves no trace in the guarded document.
 * Feed the result to {@link ValidateRefsOptions.knownStateKeys} so those reads
 * are not mistaken for dangling ones.
 *
 * @param docs - every workflow document in the project (non-middleware ones are
 *   ignored).
 */
export function middlewareStateKeys(docs: Iterable<unknown>): string[] {
	const keys = new Set<string>();
	for (const raw of docs) {
		if (!isPlainObject(raw)) continue;
		const doc = unwrapEnvelope(raw);
		if (doc.middleware !== true || !Array.isArray(doc.steps)) continue;
		const producers = new Map<string, Producer[]>();
		collectProducers(doc.steps, [], undefined, producers, new Set());
		for (const key of producers.keys()) keys.add(key);
	}
	return [...keys].sort();
}

// ─────────────────────────────── internals ──────────────────────────────────

/** One control-flow arm on the path from the workflow root to a step. */
interface ScopeFrame {
	readonly flowStep: string;
	readonly arm: string;
	/**
	 * Whether sibling arms of this flow step are MUTUALLY EXCLUSIVE at run time.
	 * True for `branch` (then/else) and `switch` (case/default). False for
	 * `tryCatch` — reading a `try` step's output from the `catch` arm is the
	 * documented saga/rollback pattern, and `finally` sees everything.
	 */
	readonly exclusive: boolean;
}

interface Producer {
	readonly stepId: string;
	readonly scope: readonly ScopeFrame[];
	readonly ephemeral: boolean;
	/**
	 * `undefined` ⇒ the node advertises no output schema (unchecked).
	 * `null` ⇒ the slot is not written at all by this step (a `spread: true`
	 * step's own id), which reads as dangling with a spread-specific hint.
	 */
	readonly schema: unknown;
	readonly unchecked: boolean;
	readonly spreadRoot: boolean;
}

interface RefSite {
	readonly root: string;
	readonly path: readonly (string | number)[];
	readonly docPath: string;
	readonly readerStep: string;
	readonly readerScope: readonly ScopeFrame[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Unwrap a v2 / legacy builder envelope to its inner config. Mirrors
 * `validateWorkflow`'s unwrap (and `WorkflowNormalizer`'s) so a caller may pass
 * the raw `workflow()` return value. Duplicated here rather than imported to
 * keep this module dependency-free for the browser bundle.
 */
function unwrapEnvelope(doc: Record<string, unknown>): Record<string, unknown> {
	if (doc._blokV2 === true && isPlainObject(doc._config)) return doc._config;
	if (isPlainObject(doc._config) && doc.name === undefined && doc.steps === undefined) return doc._config;
	return doc;
}

/**
 * True when the workflow can legitimately read state it did not write itself —
 * a middleware workflow runs on the PARENT ctx, and a workflow that declares
 * `middleware: [...]` inherits whatever its middleware wrote. Dangling-root
 * errors are downgraded to warnings for those, because the producer lives in a
 * different document and this pass cannot see it.
 */
function hasForeignState(doc: Record<string, unknown>): boolean {
	// `middleware: true` — this doc IS middleware, running on the parent ctx.
	// `middleware: [...]` — workflow-level chain (v0.5.2).
	if (doc.middleware === true) return true;
	if (Array.isArray(doc.middleware) && doc.middleware.length > 0) return true;
	const trigger = doc.trigger;
	if (!isPlainObject(trigger)) return false;
	for (const cfg of Object.values(trigger)) {
		if (isPlainObject(cfg) && Array.isArray(cfg.middleware) && cfg.middleware.length > 0) return true;
	}
	return false;
}

// ───────────────────────────── producer collection ──────────────────────────

/** Fields that hold nested step pipelines, walked as steps rather than values. */
function subPipelines(step: Record<string, unknown>): Array<{ arm: string; steps: unknown[]; exclusive: boolean }> {
	const out: Array<{ arm: string; steps: unknown[]; exclusive: boolean }> = [];
	const branch = step.branch;
	if (isPlainObject(branch)) {
		if (Array.isArray(branch.then)) out.push({ arm: "then", steps: branch.then, exclusive: true });
		if (Array.isArray(branch.else)) out.push({ arm: "else", steps: branch.else, exclusive: true });
	}
	const sw = step.switch;
	if (isPlainObject(sw)) {
		if (Array.isArray(sw.cases)) {
			sw.cases.forEach((c, i) => {
				if (isPlainObject(c) && Array.isArray(c.do)) out.push({ arm: `case:${i}`, steps: c.do, exclusive: true });
			});
		}
		if (Array.isArray(sw.default)) out.push({ arm: "default", steps: sw.default, exclusive: true });
	}
	const tc = step.tryCatch;
	if (isPlainObject(tc)) {
		for (const arm of ["try", "catch", "finally"] as const) {
			const body = tc[arm];
			if (Array.isArray(body)) out.push({ arm, steps: body, exclusive: false });
		}
	}
	const fe = step.forEach;
	if (isPlainObject(fe) && Array.isArray(fe.do)) out.push({ arm: "do", steps: fe.do, exclusive: false });
	const loop = step.loop;
	if (isPlainObject(loop) && Array.isArray(loop.do)) out.push({ arm: "do", steps: loop.do, exclusive: false });
	return out;
}

/**
 * The framework's own state-publishing primitives. Every other node returns
 * output and lets the runner persist it under the step's key, but these two
 * exist precisely to write a NAMED slot, so the key they write is part of the
 * IR (a literal `inputs.name` / `inputs.values` map) and this pass can read it.
 * Recognising them is the framework knowing its own primitives, not per-node
 * coupling.
 *
 * ponytail: the two shipped publishers only. A CUSTOM node calling
 * `ctx.publish(name, …)` inside `execute()` is invisible here — that is what
 * {@link ValidateRefsOptions.knownStateKeys} is for.
 */
function publishedKeys(step: Record<string, unknown>): string[] {
	const use = asString(step.use);
	const inputs = isPlainObject(step.inputs) ? step.inputs : undefined;
	if (!use || !inputs) return [];
	if (refIs(use, "@blokjs/ctx-publish")) {
		const name = asString(inputs.name);
		return name ? [name] : [];
	}
	if (refIs(use, "@blokjs/ctx-publish-many") && isPlainObject(inputs.values)) {
		return Object.keys(inputs.values);
	}
	return [];
}

/**
 * Scope-insensitive node-ref compare. The runner's canonical node-key rule
 * (ADR 0002) resolves the bare form (`ctx-publish`) and the scoped form
 * (`@blokjs/ctx-publish`) to the SAME node, and the shipped corpus writes
 * both — `examples/v05-primitives/09-polling-with-backoff.json` publishes
 * `attempt` via bare `ctx-publish`. Matching only the scoped form made every
 * bare-ref publish invisible, which surfaced as 8 false dangling-step errors
 * the moment #690's corpus migration turned previously-unparseable
 * dollar-prefixed state strings into structural refs this pass could
 * finally read.
 */
function refIs(use: string, canonical: string): boolean {
	return use === canonical || use === canonical.replace(/^@[^/]+\//, "");
}

/** True for the control-flow shapes that never persist their own state slot. */
function isFlowStep(step: Record<string, unknown>): boolean {
	return (
		isPlainObject(step.branch) || isPlainObject(step.switch) || isPlainObject(step.tryCatch) || isPlainObject(step.loop)
	);
}

/** Top-level `properties` of an object schema, for `spread: true` resolution. */
function topLevelProperties(schema: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(schema)) return undefined;
	const props = schema.properties;
	return isPlainObject(props) ? props : undefined;
}

function collectProducers(
	steps: readonly unknown[],
	scope: readonly ScopeFrame[],
	lookup: NodeSchemaLookup | undefined,
	out: Map<string, Producer[]>,
	unchecked: Set<string>,
): void {
	for (const raw of steps) {
		if (!isPlainObject(raw)) continue;
		const id = asString(raw.id);
		if (!id) continue;

		const nested = subPipelines(raw);
		const fe = isPlainObject(raw.forEach) ? raw.forEach : undefined;

		if (fe) {
			// The loop's results array lands at `state[id]`. Its element shape is
			// the inner pipeline's business, so declare it as a bare array: a walk
			// into `[0].whatever` then hits a free-form subtree and stays quiet.
			push(out, id, {
				stepId: id,
				scope,
				ephemeral: false,
				schema: { type: "array" },
				unchecked: false,
				spreadRoot: false,
			});
			// footgun #4 — `as` / `<as>Index` share the step-id namespace. They are
			// written per iteration, so they are scoped to the loop body.
			const as = asString(fe.as);
			if (as) {
				const bodyScope: ScopeFrame[] = [...scope, { flowStep: id, arm: "do", exclusive: false }];
				push(out, as, {
					stepId: id,
					scope: bodyScope,
					ephemeral: false,
					schema: undefined,
					unchecked: false,
					spreadRoot: false,
				});
				push(out, `${as}Index`, {
					stepId: id,
					scope: bodyScope,
					ephemeral: false,
					schema: { type: "number" },
					unchecked: false,
					spreadRoot: false,
				});
			}
		} else if (!isFlowStep(raw)) {
			const use = asString(raw.use);
			const isSub = typeof raw.subworkflow === "string";
			// A sub-workflow step's output is the child's response — a different
			// document's shape. Unknown but not "missing a schema the node should
			// have declared", so it is silent rather than counted as unchecked.
			const schema = use && lookup ? lookup(use) : undefined;
			const noSchema = schema === undefined;
			const isUnchecked = noSchema && !isSub && !isPlainObject(raw.wait);
			if (isUnchecked) unchecked.add(id);
			const ephemeral = raw.ephemeral === true;
			const spread = raw.spread === true;
			const key = asString(raw.as) ?? id;

			if (spread) {
				// `spread: true` shallow-merges the output's top-level keys into
				// state; the step's own id is NOT a slot (#342).
				push(out, id, {
					stepId: id,
					scope,
					ephemeral,
					schema: null,
					unchecked: isUnchecked,
					spreadRoot: true,
				});
				const props = topLevelProperties(schema);
				if (props) {
					for (const [propKey, propSchema] of Object.entries(props)) {
						push(out, propKey, {
							stepId: id,
							scope,
							ephemeral,
							schema: propSchema,
							unchecked: false,
							spreadRoot: false,
						});
					}
				}
			} else {
				push(out, key, { stepId: id, scope, ephemeral, schema, unchecked: isUnchecked, spreadRoot: false });
			}

			// `@blokjs/ctx-publish[-many]` additionally writes the slot(s) named in
			// its inputs. The published VALUE's shape is not in the IR, so those
			// slots are free-form: readable, never field-checked, never "unchecked".
			for (const published of publishedKeys(raw)) {
				push(out, published, {
					stepId: id,
					scope,
					ephemeral: false,
					schema: {},
					unchecked: false,
					spreadRoot: false,
				});
			}
		}

		for (const arm of nested) {
			collectProducers(
				arm.steps,
				[...scope, { flowStep: id, arm: arm.arm, exclusive: arm.exclusive }],
				lookup,
				out,
				unchecked,
			);
		}
	}
}

function push(map: Map<string, Producer[]>, key: string, producer: Producer): void {
	const list = map.get(key);
	if (list) list.push(producer);
	else map.set(key, [producer]);
}

// ─────────────────────────────── ref collection ─────────────────────────────

/**
 * Step fields that are never expressions. `ui`/`description` are free text and
 * scanning them would let a comment mentioning `ctx.state.foo` fake a ref.
 */
const NON_EXPRESSION_FIELDS = new Set(["ui", "description", "id", "type", "runtime", "as", "retry"]);

function collectRefs(steps: readonly unknown[], scope: readonly ScopeFrame[], docPath: string, out: RefSite[]): void {
	steps.forEach((raw, index) => {
		if (!isPlainObject(raw)) return;
		const stepPath = `${docPath}[${index}]`;
		const stepId = asString(raw.id) ?? `<step ${index}>`;
		const nested = subPipelines(raw);
		const nestedArrays = new Set<unknown>(nested.map((n) => n.steps));

		// Every remaining field is scanned the same way — `inputs`, `branch.when`,
		// `switch.on`, `forEach.in`, `idempotencyKey`, `subworkflow`, whatever a
		// future field adds. One rule, no per-site enumeration to keep in sync.
		for (const [field, value] of Object.entries(raw)) {
			if (NON_EXPRESSION_FIELDS.has(field)) continue;
			scanValue(value, `${stepPath}.${field}`, stepId, scope, out, nestedArrays);
		}

		for (const arm of nested) {
			collectRefs(arm.steps, [...scope, { flowStep: stepId, arm: arm.arm, exclusive: arm.exclusive }], stepPath, out);
		}
	});
}

/** Recursively scan a value for structural refs and expression strings. */
function scanValue(
	value: unknown,
	docPath: string,
	stepId: string,
	scope: readonly ScopeFrame[],
	out: RefSite[],
	skip?: ReadonlySet<unknown>,
): void {
	if (value === null || value === undefined) return;
	if (skip?.has(value)) return;

	if (typeof value === "string") {
		for (const parsed of parseCtxExpression(value)) {
			out.push({ ...parsed, docPath, readerStep: stepId, readerScope: scope });
		}
		return;
	}

	if (Array.isArray(value)) {
		value.forEach((item, i) => scanValue(item, `${docPath}[${i}]`, stepId, scope, out, skip));
		return;
	}

	if (!isPlainObject(value)) return;

	if (isStructuralRef(value)) {
		pushStructural(value, docPath, stepId, scope, out);
		return;
	}
	if (isStructuralTpl(value)) {
		(value.$tpl as unknown[]).forEach((segment, i) => {
			if (isPlainObject(segment) && isStructuralRef(segment)) {
				pushStructural(segment, `${docPath}.$tpl[${i}]`, stepId, scope, out);
			}
		});
		return;
	}

	for (const [key, child] of Object.entries(value)) {
		if (NON_EXPRESSION_FIELDS.has(key)) continue;
		scanValue(child, `${docPath}.${key}`, stepId, scope, out, skip);
	}
}

function pushStructural(
	ref: StructuralRef,
	docPath: string,
	stepId: string,
	scope: readonly ScopeFrame[],
	out: RefSite[],
): void {
	const root = ref.$ref.step;
	// `@trigger` → ctx.request, `@error` → ctx.error. Neither is a step and
	// neither has a declared schema here (workflow `input` typing is #678).
	if (root === TRIGGER_SENTINEL || root === ERROR_SENTINEL) return;
	out.push({ root, path: ref.$ref.path ?? [], docPath, readerStep: stepId, readerScope: scope });
}

// ────────────────────────────── schema walking ──────────────────────────────

type WalkResult =
	| { readonly kind: "ok" }
	/** Free-form / undeclared subtree — nothing provable, nothing to report. */
	| { readonly kind: "free" }
	| { readonly kind: "unprovable"; readonly field: string }
	| { readonly kind: "unknown"; readonly field: string; readonly fields: readonly string[] };

const RANK: Record<WalkResult["kind"], number> = { ok: 3, free: 2, unprovable: 1, unknown: 0 };

function better(a: WalkResult, b: WalkResult): WalkResult {
	return RANK[b.kind] > RANK[a.kind] ? b : a;
}

/** `anyOf` / `oneOf` / `allOf` members — a path valid in ANY member is valid. */
function unionMembers(schema: Record<string, unknown>): unknown[] | undefined {
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const members = schema[key];
		if (Array.isArray(members) && members.length > 0) return members;
	}
	return undefined;
}

function schemaTypes(schema: Record<string, unknown>): string[] {
	const type = schema.type;
	if (typeof type === "string") return [type];
	if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
	return [];
}

function walkSchema(schema: unknown, path: readonly (string | number)[]): WalkResult {
	if (path.length === 0) return { kind: "ok" };
	if (!isPlainObject(schema)) return { kind: "free" };

	const members = unionMembers(schema);
	if (members) {
		let best: WalkResult = { kind: "unknown", field: String(path[0]), fields: [] };
		for (const member of members) {
			const result = walkSchema(member, path);
			if (result.kind === "ok") return result;
			// Merge the declared-field lists across members so the message can
			// suggest every field the union could offer.
			if (result.kind === "unknown" && best.kind === "unknown") {
				best = { kind: "unknown", field: result.field, fields: [...new Set([...best.fields, ...result.fields])] };
			} else {
				best = better(best, result);
			}
		}
		return best;
	}

	// An unresolved `$ref` (SDK schemas with `definitions`) is not walkable.
	if (typeof schema.$ref === "string") return { kind: "free" };

	const seg = path[0];
	const rest = path.slice(1);
	const types = schemaTypes(schema);
	const props = isPlainObject(schema.properties) ? schema.properties : undefined;

	if (types.includes("array") || (types.length === 0 && schema.items !== undefined && props === undefined)) {
		if (typeof seg === "number") {
			const items = schema.items;
			// Tuple form: `items` is an array of positional schemas.
			if (Array.isArray(items)) return walkSchema(items[seg], rest);
			return walkSchema(items, rest);
		}
		// A string key on an array is a JS property (`length`, `map`, …) — valid
		// JS, not a schema field. Nothing to prove.
		return { kind: "free" };
	}

	// Scalars carry real JS members too (`.length` on a string); never an error.
	if (types.length > 0 && !types.includes("object")) return { kind: "free" };

	// `in` over Object.hasOwn: this module targets the Studio browser bundle too,
	// whose lib is ES2020. Prototype keys are not a risk — these are parsed JSON
	// Schemas, and a `properties` key named `toString` is still a declared field.
	if (props && typeof seg === "string" && Object.prototype.hasOwnProperty.call(props, seg)) {
		return walkSchema(props[seg], rest);
	}

	const additional = schema.additionalProperties;
	if (props === undefined) {
		// No declared shape at all (`z.record`, `z.any`, `{}`) — free-form.
		return { kind: "free" };
	}
	if (additional === false) {
		return { kind: "unknown", field: String(seg), fields: Object.keys(props) };
	}
	// `additionalProperties` absent defaults to `true` in JSON Schema, and an
	// explicit `true` / sub-schema is the `.passthrough()` case: the key MAY be
	// there. Absence cannot be proven → warning, not error.
	return { kind: "unprovable", field: String(seg) };
}

// ──────────────────────────────── the pass ──────────────────────────────────

/**
 * Check every step-output reference in a workflow document against the
 * producing step's declared output schema.
 *
 * Advisory by construction: it returns diagnostics, it never throws and never
 * mutates. Callers decide whether an error fails a build (#305/#308 scope).
 */
export function validateRefs(doc: unknown, opts: ValidateRefsOptions = {}): ValidateRefsResult {
	if (!isPlainObject(doc)) return { ok: true, diagnostics: [], uncheckedSteps: [] };
	const workflow = unwrapEnvelope(doc);
	const steps = workflow.steps;
	if (!Array.isArray(steps)) return { ok: true, diagnostics: [], uncheckedSteps: [] };

	const workflowName = opts.workflowName ?? asString(workflow.name) ?? "<unknown workflow>";
	const known = new Set(opts.knownStateKeys ?? []);
	// A workflow that declares middleware inherits whatever the middleware wrote.
	// When the caller supplied the project's real middleware keys we use those;
	// otherwise (a single document in Studio) we can only soften the verdict.
	const foreignState = known.size === 0 && hasForeignState(workflow);

	const producers = new Map<string, Producer[]>();
	const uncheckedSteps = new Set<string>();
	collectProducers(steps, [], opts.nodes, producers, uncheckedSteps);

	const sites: RefSite[] = [];
	collectRefs(steps, [], "steps", sites);

	const diagnostics: RefDiagnostic[] = [];
	const seen = new Set<string>();
	const emit = (d: RefDiagnostic): void => {
		// One diagnostic per (code, doc location, producer, field). Root-level codes
		// drop the field from the key: a dangling root is ONE problem however many
		// fields hang off it in the same expression.
		const rootLevel = d.code === "dangling-step" || d.code === "ephemeral-read" || d.code === "arm-escape";
		const key = `${d.code} ${d.path} ${d.producer} ${rootLevel ? "" : d.refPath}`;
		if (seen.has(key)) return;
		seen.add(key);
		diagnostics.push(d);
	};

	for (const site of sites) {
		// Written by middleware or by a node's `ctx.publish()` — outside this
		// document, so not ours to judge.
		if (known.has(site.root)) continue;
		const refPath = renderRefPath(site.path);
		const base = { path: site.docPath, step: site.readerStep, producer: site.root, refPath };
		const candidates = producers.get(site.root);

		if (!candidates || candidates.length === 0) {
			emit({
				...base,
				// A middleware-bearing workflow legitimately reads state written by
				// another document; we cannot see that producer, so warn.
				severity: foreignState ? "warning" : "error",
				code: "dangling-step",
				message:
					`Step "${site.readerStep}" in workflow "${workflowName}" references state \`${site.root}\`, which no step writes.` +
					`\n  hint: no step in this workflow persists \`ctx.state.${site.root}\`. Likely a typo'd id, an \`ephemeral: true\` step, or a wrong \`as\`/\`spread\`.` +
					`\n  fix: ensure a step's id (or its \`as:\`) is exactly "${site.root}".`,
			});
			continue;
		}

		const reachable = candidates.filter((p) => !isArmExclusive(p.scope, site.readerScope));
		if (reachable.length === 0) {
			const armed = candidates[0];
			emit({
				...base,
				severity: "error",
				code: "arm-escape",
				message: `Step "${site.readerStep}" in workflow "${workflowName}" references state \`${site.root}\`, produced by step "${armed?.stepId ?? site.root}" in a mutually exclusive control-flow arm — the two never run in the same execution.\n  fix: move the read into the same arm, or have both arms write a shared \`as:\` key.`,
			});
			continue;
		}

		const writable = reachable.filter((p) => !p.ephemeral && !p.spreadRoot);
		if (writable.length === 0) {
			const producer = reachable[0];
			if (producer?.spreadRoot) {
				emit({
					...base,
					severity: "error",
					code: "dangling-step",
					message:
						`Step "${site.readerStep}" in workflow "${workflowName}" references state \`${site.root}\`, but step "${producer.stepId}" declares \`spread: true\` — it merges its output's KEYS into state and never writes \`state.${site.root}\`.` +
						`\n  fix: reference the spread key directly (e.g. \`ctx.state.<key>\`), or drop \`spread: true\` so the step writes \`state.${site.root}\`.`,
				});
			} else {
				emit({
					...base,
					severity: "error",
					code: "ephemeral-read",
					message: `Step "${site.readerStep}" in workflow "${workflowName}" references state \`${site.root}\`, but step "${producer?.stepId ?? site.root}" declares \`ephemeral: true\` — its handle is unreadable and no state slot is written.\n  fix: drop \`ephemeral: true\` on the producing step, or read the value from \`ctx.prev\` in the immediately next step.`,
				});
			}
			continue;
		}

		if (site.path.length === 0) continue;

		if (writable.every((p) => p.unchecked)) {
			const producer = writable[0];
			emit({
				...base,
				severity: "warning",
				code: "unchecked-node",
				message: `Step "${site.readerStep}" reads \`${site.root}.${refPath}\`, but step "${producer?.stepId ?? site.root}" advertises no output schema — the field cannot be checked.`,
			});
			continue;
		}

		let best: WalkResult | undefined;
		for (const producer of writable) {
			const result: WalkResult = producer.unchecked ? { kind: "free" } : walkSchema(producer.schema, site.path);
			best = best ? better(best, result) : result;
			if (best.kind === "ok") break;
		}

		if (best?.kind === "unknown") {
			const declared = best.fields.length > 0 ? best.fields.join(", ") : "(none)";
			emit({
				...base,
				severity: "error",
				code: "unknown-field",
				fields: best.fields,
				message:
					`Step "${site.readerStep}" in workflow "${workflowName}" reads \`${site.root}.${refPath}\`, but "${best.field}" is not declared in the output schema of the node behind step "${writable[0]?.stepId ?? site.root}".` +
					`\n  declared fields: ${declared}` +
					`\n  fix: reference a declared field, or add "${best.field}" to the node's \`output\` schema.`,
			});
		} else if (best?.kind === "unprovable") {
			emit({
				...base,
				severity: "warning",
				code: "unprovable-field",
				message: `Step "${site.readerStep}" reads \`${site.root}.${refPath}\`, and "${best.field}" is not declared in the producer's output schema — the schema is open (\`additionalProperties\`), so the field may or may not be there.`,
			});
		}
	}

	return {
		ok: !diagnostics.some((d) => d.severity === "error"),
		diagnostics,
		uncheckedSteps: [...uncheckedSteps].sort(),
	};
}

/**
 * True when producer and reader sit in DIFFERENT arms of the same mutually
 * exclusive flow step — the only relationship the IR can prove unreachable.
 *
 * A producer in a `then` arm read AFTER the branch is NOT flagged: state is one
 * flat object at run time, so that read succeeds whenever the arm ran. That is
 * a conditional read, not a proven bug, and the JSON corpus relies on it.
 */
function isArmExclusive(producerScope: readonly ScopeFrame[], readerScope: readonly ScopeFrame[]): boolean {
	const depth = Math.min(producerScope.length, readerScope.length);
	for (let i = 0; i < depth; i++) {
		const p = producerScope[i];
		const r = readerScope[i];
		if (!p || !r) return false;
		if (p.flowStep !== r.flowStep) return false;
		if (p.arm !== r.arm) return p.exclusive;
	}
	return false;
}
