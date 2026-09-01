import { parseDuration, unresolvableKeyShape } from "@blokjs/helper";
import {
	type CapabilityManifestV1,
	isStructuralRef,
	isStructuralTpl,
	lowerRefs,
	parseCapabilityManifest,
} from "@blokjs/shared";

/**
 * WorkflowNormalizer — accepts v1 or v2 workflow shapes and projects both
 * to the single canonical internal shape that `Configuration.getSteps` /
 * `Configuration.getNodes` already consume.
 *
 * **Input shapes accepted**
 *
 * v1 (legacy):
 * ```
 * {
 *   name, version, trigger,
 *   steps: [{ name, node, type, active?, stop? }],
 *   nodes: { [stepName]: { inputs?, conditions? } }
 * }
 * ```
 *
 * v2 (canonical):
 * ```
 * {
 *   name, version, trigger,
 *   steps: [
 *     { id, use, type?, inputs?, as?, spread?, ephemeral?, active?, stop? }
 *   | { id, branch: { when, then, else? } }
 *   ]
 * }
 * ```
 *
 * **Output shape** (always v1-compatible internal):
 * ```
 * {
 *   name, version, trigger,           // method "*" normalized to "ANY"
 *   steps: [{ name, node, type, active, stop, as, spread, ephemeral, ... }],
 *   nodes: { [stepName]: { inputs?, conditions? } }
 * }
 * ```
 *
 * **Why a single internal shape?** The runner core (RunnerSteps,
 * Configuration, Blok.run, etc.) is unchanged. Normalization is purely
 * an authoring-layer concern. Old workflows keep running; new authoring
 * shapes get translated transparently.
 */

const IF_ELSE_NODE_REF = "@blokjs/if-else";

let _wildcardWarnedFiles = new Set<string>();
let _legacyExprWarnedFiles = new Set<string>();

interface RetryConfig {
	maxAttempts: number;
	minTimeoutInMs?: number;
	maxTimeoutInMs?: number;
	factor?: number;
	nonRetryableErrorNames?: string[];
}

interface InternalStep {
	name: string;
	node: string;
	type: string;
	active?: boolean;
	stop?: boolean;
	as?: string;
	spread?: boolean;
	ephemeral?: boolean;
	stream_logs?: boolean;
	/**
	 * Live data-event destination for a runtime step's `PartialResult`
	 * frames. `"sse"` forwards each partial to `ctx.stream.writeSSE(...)`
	 * as it arrives. `stream: true` is shorthand for `streamTo: "sse"`.
	 * Read by `Configuration.runtimeResolver`.
	 */
	streamTo?: string;
	stream?: boolean;
	flow?: boolean;
	idempotencyKey?: string;
	idempotencyKeyTTL?: number;
	retry?: RetryConfig;
	subworkflow?: string;
	wait?: boolean;
	/**
	 * Tier 2 quick-wins — per-attempt execution timeout. Number (ms) or
	 * duration string (`"30s"`, etc.). Configuration thread-through
	 * normalizes to milliseconds via `parseDuration`.
	 */
	maxDuration?: number | string;
	/**
	 * PR 4 — `wait.for(duration)` / `wait.until(date)` step.
	 *
	 * Discriminates by `type === "wait"` and the presence of either
	 * `waitForMs` (numeric ms after parseDuration) or `waitUntil` (number
	 * ms-since-epoch OR ISO date string).
	 *
	 * `wait?: boolean` above is the sub-workflow `wait: true|false` flag
	 * — separate concern, separate field.
	 */
	waitForMs?: number;
	waitUntil?: number | string;
	/**
	 * #704 — the DEFERRED half of the two fields above. A `wait.for` /
	 * `wait.until` written as a reference (a structural `{$ref}` lowered here,
	 * or a `js/…` escape hatch) cannot be parsed at load time, so it is carried
	 * as a wire-format expression and resolved against the live ctx by
	 * `RunnerSteps` at the moment the wait step executes. Exactly one of
	 * (`waitForMs` | `waitForExpr` | `waitUntil` | `waitUntilExpr`) is set.
	 */
	waitForExpr?: string;
	waitUntilExpr?: string;
	/**
	 * Optional Studio/canvas authoring metadata (position, notes, passthrough
	 * keys). Accepted by all 8 v2 step schemas; the runner IGNORES it at
	 * execution. Threaded verbatim through normalization so the canvas
	 * IR→normalize→toJson round-trip preserves it (issue #301).
	 */
	ui?: Record<string, unknown>;
	/**
	 * Optional human note on the step — accepted by all 8 v2 step schemas
	 * (#711) and ignored by the runner, exactly like `ui`. Threaded through
	 * normalization so a Studio open→save round-trip doesn't silently drop the
	 * author's description (issue #713).
	 */
	description?: string;
	[key: string]: unknown;
}

interface InternalNodeConfig {
	inputs?: Record<string, unknown>;
	conditions?: InternalCondition[];
	steps?: InternalStep[];
	[key: string]: unknown;
}

interface InternalCondition {
	type: "if" | "else";
	condition?: string;
	steps: InternalStep[];
}

export interface InternalWorkflow {
	name: string;
	version: string;
	description?: string;
	trigger: Record<string, unknown>;
	steps: InternalStep[];
	nodes: Record<string, InternalNodeConfig>;
	/**
	 * v0.5 — when `true`, this workflow is registered as middleware and is
	 * NOT exposed as a public HTTP route. Invoked from another workflow's
	 * `trigger.http.middleware: [...]` array (or `appliedMiddleware` below).
	 */
	middleware?: true;
	/**
	 * v0.5.2 — workflow-level middleware chain. Authors write `middleware:
	 * [...]` at the top level of the workflow definition; the normalizer
	 * routes the array form here while keeping `middleware: true` as the
	 * marker bit. Applies to ALL triggers of this workflow, runs BEFORE
	 * any trigger-level middleware. Use this when a chain (auth, rate-limit)
	 * applies uniformly across every trigger of a workflow — saves
	 * repeating the same list on every trigger config.
	 *
	 * Mutually exclusive with `middleware: true` — a workflow cannot
	 * simultaneously be a middleware AND apply other middleware to itself.
	 */
	appliedMiddleware?: readonly string[];
	/**
	 * v0.7 — typed-client authoring metadata, carried verbatim through
	 * normalization (previously stripped). A Zod schema for TS workflows, a
	 * JSON Schema for JSON workflows. `input` powers the `mcp` trigger + the
	 * typed `@blokjs/client` request type; `output` powers the client's return
	 * type + optional `BLOK_VALIDATE_WORKFLOW_OUTPUT` enforcement; `events`
	 * powers the typed streaming event union. None are serialized by the runner.
	 */
	input?: unknown;
	output?: unknown;
	events?: Record<string, unknown>;
	/** Structured operational metadata used by catalog and agent policy. */
	capabilityManifest?: CapabilityManifestV1;
}

/**
 * Convert any accepted workflow shape into the canonical internal shape.
 *
 * Mutates a deep copy — the caller's object is never modified.
 *
 * @param raw - parsed workflow object (from JSON.parse, dynamic import,
 *              or the v1 builder pipeline)
 * @param sourcePath - optional path used in deprecation warnings
 */
export function normalizeWorkflow(raw: unknown, sourcePath?: string): InternalWorkflow {
	if (!isPlainObject(raw)) {
		const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
		throw new Error(`[blok] WorkflowNormalizer: expected an object, got ${typeof raw}${suffix}`);
	}

	// Unwrap v2 builder envelopes — `workflow()` returns `{_blokV2: true, _config: {...}}`.
	// The legacy `Workflow()` builder also produces a `_config` field; both shapes
	// carry their workflow definition under that key.
	let wf = raw as Record<string, unknown>;
	if (wf._blokV2 === true && isPlainObject(wf._config)) {
		wf = wf._config as Record<string, unknown>;
	} else if (isPlainObject(wf._config) && wf.name === undefined && wf.steps === undefined) {
		// Legacy builder shape — same unwrap.
		wf = wf._config as Record<string, unknown>;
	}

	// `set_var` removed in v0.5. Reject at load time with a migration hint
	// — silently dropping the field would produce subtly different runtime
	// behaviour (every step now default-stores; legacy `set_var: false`
	// was the only opt-out and is replaced by `ephemeral: true`).
	if (Array.isArray(wf.steps)) {
		assertNoSetVar(wf.steps as unknown[], sourcePath);
		assertNoDuplicateStepIds(wf.steps as unknown[], sourcePath);
		assertNoForEachStateKeyCollisions(wf.steps as unknown[], sourcePath);
	}
	// Reject genuine DSL conflicts (two fields fighting for one slot, or a
	// half-migrated v2 envelope) — but NOT the canonical `{id, node}` hybrid.
	assertNoConflictingStepDsl(wf, sourcePath);
	const name = typeof wf.name === "string" ? wf.name : "";
	// #690 — nag once per workflow about hand-written `js/` step inputs. Runs on
	// the RAW steps, before `lowerRefs` compiles any `{$ref}` into the same
	// string form, so a structural workflow never trips it.
	if (Array.isArray(wf.steps)) warnLegacyExpressionsOnce(wf.steps as unknown[], name, sourcePath);
	const version = typeof wf.version === "string" ? wf.version : "1.0.0";
	const description = typeof wf.description === "string" ? wf.description : undefined;
	const capabilityManifest =
		wf.capabilityManifest === undefined ? undefined : parseCapabilityManifest(wf.capabilityManifest);
	// v0.7 — typed-client metadata. Carried verbatim (Zod schema for TS
	// workflows, JSON Schema for JSON). Previously stripped at normalization.
	const input = wf.input;
	const output = wf.output;
	const events = isPlainObject(wf.events) ? (wf.events as Record<string, unknown>) : undefined;
	// `middleware` is overloaded:
	//   - `true`            → marker bit, this workflow IS a middleware
	//   - `string[]`        → workflow-level middleware chain (these run on
	//                         every request to this workflow, before any
	//                         trigger-level middleware)
	// The two are mutually exclusive — refuse the conflict at load time
	// rather than letting one silently win.
	const middleware = wf.middleware === true ? (true as const) : undefined;
	let appliedMiddleware: readonly string[] | undefined;
	if (Array.isArray(wf.middleware)) {
		const list = (wf.middleware as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0);
		appliedMiddleware = list.length > 0 ? list : undefined;
	}
	if (middleware === true && appliedMiddleware !== undefined) {
		const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
		throw new Error(
			`[blok] WorkflowNormalizer: workflow "${name}" sets both \`middleware: true\` (marker) and \`middleware: [...]\` (chain). These are mutually exclusive — pick one.${suffix}`,
		);
	}

	// --- Trigger normalization (method "*" → "ANY") ---
	const trigger = normalizeTrigger(wf.trigger, sourcePath);

	// --- Steps normalization ---
	const stepsInput = Array.isArray(wf.steps) ? (wf.steps as unknown[]) : [];
	const nodesInput = isPlainObject(wf.nodes) ? (wf.nodes as Record<string, unknown>) : {};

	const internalSteps: InternalStep[] = [];
	const internalNodes: Record<string, InternalNodeConfig> = {};

	for (let i = 0; i < stepsInput.length; i++) {
		const rawStep = stepsInput[i];
		if (!isPlainObject(rawStep)) continue;
		const step = rawStep as Record<string, unknown>;

		// v2 branch — { id, branch: { when, then, else? } }
		if (isPlainObject(step.branch)) {
			const { internalStep, nodeConfig, innerNodes } = normalizeBranchStep(step, i);
			internalSteps.push(internalStep);
			internalNodes[internalStep.name] = nodeConfig;
			// Promote every inner step's nodeConfig into the top-level nodes map
			// so BlokService.run can find `ctx.config[innerStep.name].inputs`
			// when the runner descends into the matching arm. Without this,
			// inner steps with `inputs:` defined inline crash with
			// `opts.inputs undefined` because their config was only attached
			// to the inner step instance, not the global lookup map.
			Object.assign(internalNodes, innerNodes);
			continue;
		}

		// v2 sub-workflow — { id, subworkflow: "<name>", inputs?, wait? }
		// Discriminator is the presence of a non-empty `subworkflow` string.
		// Resolves to a SubworkflowNode that looks up the child in the
		// WorkflowRegistry at run time.
		if (typeof step.subworkflow === "string" && step.subworkflow.length > 0) {
			const { internalStep, nodeConfig } = normalizeSubworkflowStep(step, i);
			internalSteps.push(internalStep);
			if (nodeConfig) internalNodes[internalStep.name] = nodeConfig;
			continue;
		}

		// v2 wait — { id, wait: { for?, until? } } (PR 4).
		// Discriminator: `wait` is an object (sub-workflow uses `wait: boolean`).
		if (
			isPlainObject(step.wait) &&
			((step.wait as { for?: unknown }).for !== undefined || (step.wait as { until?: unknown }).until !== undefined)
		) {
			const internalStep = normalizeWaitStep(step, i);
			internalSteps.push(internalStep);
			continue;
		}

		// v0.5 forEach — { id, forEach: { in, as, mode?, concurrency?, do: [...] } }
		if (isPlainObject(step.forEach)) {
			const { internalStep, nodeConfig, innerNodes } = normalizeForEachStep(step, i);
			internalSteps.push(internalStep);
			internalNodes[internalStep.name] = nodeConfig;
			Object.assign(internalNodes, innerNodes);
			continue;
		}

		// v0.5 loop — { id, loop: { while, maxIterations?, do: [...] } }
		if (isPlainObject(step.loop)) {
			const { internalStep, nodeConfig, innerNodes } = normalizeLoopStep(step, i);
			internalSteps.push(internalStep);
			internalNodes[internalStep.name] = nodeConfig;
			Object.assign(internalNodes, innerNodes);
			continue;
		}

		// v0.5 switch — { id, switch: { on, cases: [{when, do}], default? } }
		if (isPlainObject(step.switch)) {
			const { internalStep, nodeConfig, innerNodes } = normalizeSwitchStep(step, i);
			internalSteps.push(internalStep);
			internalNodes[internalStep.name] = nodeConfig;
			Object.assign(internalNodes, innerNodes);
			continue;
		}

		// v0.5 tryCatch — { id, tryCatch: { try, catch, finally? } }
		if (isPlainObject(step.tryCatch)) {
			const { internalStep, nodeConfig, innerNodes } = normalizeTryCatchStep(step, i);
			internalSteps.push(internalStep);
			internalNodes[internalStep.name] = nodeConfig;
			Object.assign(internalNodes, innerNodes);
			continue;
		}

		// v2 regular — { id, use, inputs?, as?, spread?, ephemeral?, ... }
		// or v1 regular — { name, node, type } + nodes[name].inputs
		const { internalStep, nodeConfig } = normalizeRegularStep(step, nodesInput, i);
		internalSteps.push(internalStep);
		if (nodeConfig) internalNodes[internalStep.name] = nodeConfig;
	}

	// --- Carry over any v1 nodes that didn't have a matching step ---
	// NOT rare: in a v1 workflow every step nested inside a `conditions` arm has
	// its config here, keyed by a name no TOP-LEVEL step carries — 10 of the 13
	// configs in `examples/integrations/stripe-payment.json`. This loop used to
	// copy them VERBATIM, so a structural `{$ref}` in one never reached
	// `lowerRefs` and landed on the node as a raw `{"$ref": {...}}` object: a
	// silent miscompile (#707). Lower here for the same reason
	// `normalizeRegularStep` lowers a matched step's inputs.
	for (const key of Object.keys(nodesInput)) {
		if (internalNodes[key] !== undefined) continue;
		const value = nodesInput[key];
		if (isPlainObject(value)) {
			internalNodes[key] = lowerRefs(value) as InternalNodeConfig;
		}
	}

	const normalized: InternalWorkflow = {
		name,
		version,
		description,
		...(capabilityManifest ? { capabilityManifest } : {}),
		trigger,
		steps: internalSteps,
		nodes: internalNodes,
		...(middleware ? { middleware } : {}),
		...(appliedMiddleware ? { appliedMiddleware } : {}),
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(events !== undefined ? { events } : {}),
	};
	assertNoUnloweredRefs(normalized, sourcePath);
	return normalized;
}

// =============================================================================
// Internals
// =============================================================================

function normalizeRegularStep(
	step: Record<string, unknown>,
	nodesInput: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig | null } {
	// Identity — `id` (v2) wins, fallback to `name` (v1).
	const id = pickString(step.id) ?? pickString(step.name);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: step at index ${index} has neither \`id\` (v2) nor \`name\` (v1).`);
	}

	// Node reference — `use` (v2) wins, fallback to `node` (v1).
	const nodeRef = pickString(step.use) ?? pickString(step.node);
	if (!nodeRef) {
		throw new Error(`[blok] WorkflowNormalizer: step "${id}" has neither \`use\` (v2) nor \`node\` (v1).`);
	}

	// Type — explicit `type` wins; otherwise inferred from the node ref.
	const explicitType = pickString(step.type);
	const type = explicitType ?? inferStepType(nodeRef);

	// Inputs — v2 inlines on the step; v1 lives at workflow.nodes[name].inputs.
	const inlineInputs = isPlainObject(step.inputs) ? (step.inputs as Record<string, unknown>) : null;
	const v1NodeConfig = isPlainObject(nodesInput[id]) ? (nodesInput[id] as InternalNodeConfig) : null;
	const v1Inputs = v1NodeConfig?.inputs && isPlainObject(v1NodeConfig.inputs) ? v1NodeConfig.inputs : null;

	const inputs = inlineInputs ?? v1Inputs;

	// Persistence knobs — v2 only. Legacy `set_var` is rejected upstream
	// in `normalizeWorkflow` via `assertNoSetVar`.
	const ephemeral = step.ephemeral === true;
	const as = pickString(step.as);
	const spread = step.spread === true;

	// `as` and `spread` are mutually exclusive — caught at schema level too,
	// repeated here so JSON workflows that bypass Zod still fail loudly.
	if (as && spread) {
		throw new Error(
			`[blok] WorkflowNormalizer: step "${id}" sets both \`as\` and \`spread\` — they are mutually exclusive.`,
		);
	}

	const internalStep: InternalStep = {
		name: id,
		node: nodeRef,
		type,
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		as,
		spread,
		ephemeral,
		...copyStepMeta(step),
	};
	if (typeof step.stream_logs === "boolean") internalStep.stream_logs = step.stream_logs;
	// Live SSE forwarding opt-in for runtime steps. `streamTo: "sse"`
	// (canonical) / `stream: true` (shorthand) reach runtimeResolver and
	// route the node's PartialResult frames to ctx.stream.writeSSE.
	if (typeof step.streamTo === "string") internalStep.streamTo = step.streamTo;
	if (typeof step.stream === "boolean") internalStep.stream = step.stream;
	// Idempotency cache + retry — pass through verbatim. The runner reads
	// these in RunnerSteps to wrap step.process() with cache-check + retry-
	// loop. They never reach PersistenceHelper.applyStepOutput; caching
	// layers ABOVE that.
	const idempotencyKey = pickResolvedKey(step.idempotencyKey);
	if (idempotencyKey) {
		internalStep.idempotencyKey = idempotencyKey;
	}
	if (typeof step.idempotencyKeyTTL === "number" && Number.isFinite(step.idempotencyKeyTTL)) {
		internalStep.idempotencyKeyTTL = step.idempotencyKeyTTL;
	}
	const retry = pickRetryConfig(step.retry);
	if (retry) internalStep.retry = retry;
	if (typeof step.maxDuration === "number" || typeof step.maxDuration === "string") {
		internalStep.maxDuration = step.maxDuration;
	}

	// Build node config — only include `inputs` if present. ADR 0001 Option C:
	// lower structural `{$ref}` handles to the `js/ctx.state...` wire strings
	// the Mapper already resolves, at the load boundary before the runner sees
	// them. No-op for `js/`/`$.` string inputs (no `{$ref}` to find).
	//
	// #707: the v1 carry-over branches lower too. A v1 step whose config is
	// `{conditions: [...]}` (no `inputs`) took the verbatim `{...v1NodeConfig}`
	// path, and a step with BOTH copied its non-`inputs` keys verbatim — either
	// way a `{$ref}` nested in there survived to the node untouched.
	let nodeConfig: InternalNodeConfig | null = null;
	if (inputs) {
		nodeConfig = { inputs: lowerRefs(inputs) };
		// Carry over any legacy v1 node-config fields that aren't `inputs`
		// (some workflows attach `outputs`, `mapper`, etc.).
		if (v1NodeConfig) {
			for (const k of Object.keys(v1NodeConfig)) {
				if (k === "inputs") continue;
				nodeConfig[k] = lowerRefs((v1NodeConfig as Record<string, unknown>)[k]);
			}
		}
	} else if (v1NodeConfig) {
		nodeConfig = lowerRefs({ ...v1NodeConfig });
	}

	return { internalStep, nodeConfig };
}

function normalizeBranchStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig; innerNodes: Record<string, InternalNodeConfig> } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: branch step at index ${index} is missing \`id\`.`);
	}
	const branch = step.branch as Record<string, unknown>;
	const when = pickString(branch.when);
	if (!when) {
		throw new Error(`[blok] WorkflowNormalizer: branch step "${id}" is missing \`when\` (must be a non-empty string).`);
	}
	const thenSteps = Array.isArray(branch.then) ? (branch.then as unknown[]) : [];
	const elseSteps = Array.isArray(branch.else) ? (branch.else as unknown[]) : [];

	// Normalize each branch's nested steps recursively via the shared
	// `normalizeStepBlock` helper (same path forEach/loop/switch/tryCatch use).
	// It handles EVERY nested step kind — regular, branch, forEach, loop,
	// switch, tryCatch, wait, subworkflow — and inlines `inputs` + bubbles up
	// `innerNodes` identically to the previous hand-rolled loops, which only
	// special-cased a nested `branch` (so a nested forEach/switch/etc. inside a
	// branch arm used to crash in `normalizeRegularStep`).
	const innerNodes: Record<string, InternalNodeConfig> = {};
	const thenBlock = normalizeStepBlock(thenSteps);
	Object.assign(innerNodes, thenBlock.innerNodes);
	const thenInternal = thenBlock.innerInternal;
	const elseBlock = normalizeStepBlock(elseSteps);
	Object.assign(innerNodes, elseBlock.innerNodes);
	const elseInternal = elseBlock.innerInternal;

	const conditions: InternalCondition[] = [{ type: "if", condition: when, steps: thenInternal }];
	if (elseInternal.length > 0) {
		conditions.push({ type: "else", steps: elseInternal });
	}

	const internalStep: InternalStep = {
		name: id,
		node: IF_ELSE_NODE_REF,
		type: "module",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		flow: true,
		...copyStepMeta(step),
	};
	const nodeConfig: InternalNodeConfig = { conditions };

	return { internalStep, nodeConfig, innerNodes };
}

const SUBWORKFLOW_NODE_REF = "@blokjs/subworkflow";

/**
 * Normalize a v2 sub-workflow step into the canonical InternalStep
 * shape. Resolves to a `SubworkflowNode` at run time
 * (Configuration.nodeTypes.subworkflow).
 *
 * Inputs are placed on `nodeConfig.inputs` so the existing
 * blueprint-mapper resolution path resolves `js/ctx.state.<id>` /
 * `js/ctx.request.body.<key>` refs into concrete values BEFORE the
 * sub-workflow node runs (mirrors how regular steps work).
 */
function normalizeSubworkflowStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig | null } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: sub-workflow step at index ${index} is missing \`id\`.`);
	}
	const subworkflow = pickString(step.subworkflow);
	if (!subworkflow) {
		throw new Error(
			`[blok] WorkflowNormalizer: sub-workflow step "${id}" is missing \`subworkflow\` (workflow name to invoke).`,
		);
	}
	// `wait: false` (fire-and-forget) is now supported. The async dispatch
	// branch lives in SubworkflowNode.run; the field is threaded through
	// onto InternalStep below for the resolver to copy onto the
	// SubworkflowNode instance.

	// Persistence + retry + idempotency knobs — pass through verbatim
	// (mirrors normalizeRegularStep). `as` and `spread` mutual exclusion
	// is also enforced at the schema level; defensive check here.
	const ephemeral = step.ephemeral === true;
	const as = pickString(step.as);
	const spread = step.spread === true;
	if (as && spread) {
		throw new Error(
			`[blok] WorkflowNormalizer: sub-workflow step "${id}" sets both \`as\` and \`spread\` — they are mutually exclusive.`,
		);
	}

	const internalStep: InternalStep = {
		name: id,
		node: SUBWORKFLOW_NODE_REF,
		type: "subworkflow",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		as,
		spread,
		ephemeral,
		subworkflow,
		// Default `wait: true` when omitted. `wait: false` triggers the
		// async dispatch branch in SubworkflowNode.run.
		wait: step.wait === undefined ? true : Boolean(step.wait),
		...copyStepMeta(step),
	};

	const idempotencyKey = pickResolvedKey(step.idempotencyKey);
	if (idempotencyKey) {
		internalStep.idempotencyKey = idempotencyKey;
	}
	if (typeof step.idempotencyKeyTTL === "number" && Number.isFinite(step.idempotencyKeyTTL)) {
		internalStep.idempotencyKeyTTL = step.idempotencyKeyTTL;
	}
	const retry = pickRetryConfig(step.retry);
	if (retry) internalStep.retry = retry;
	if (typeof step.maxDuration === "number" || typeof step.maxDuration === "string") {
		internalStep.maxDuration = step.maxDuration;
	}
	// G3 polymorphic-dispatch safety net — narrow the registry lookup to a
	// fixed set when `subworkflow` is an expression (or just to harden a
	// literal). Filter to non-empty strings here so SubworkflowNode can
	// trust the shape and skip a defensive check on the hot path.
	if (Array.isArray(step.allowList)) {
		const cleaned = (step.allowList as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0);
		if (cleaned.length > 0) {
			internalStep.allowList = cleaned;
		}
	}
	// G2 (v0.6) — dispatch strategy. Unknown / missing values fall
	// through as "in-process" inside SubworkflowNode.run, but pass the
	// raw string so the resolver can validate + threading bugs surface
	// at config load instead of at run time.
	if (step.dispatch === "in-process" || step.dispatch === "http-self") {
		internalStep.dispatch = step.dispatch;
	}

	// Inputs land on nodeConfig so the blueprint mapper resolves
	// $.<path> / js/... refs before SubworkflowNode reads them via
	// `ctx.config[step.name]`.
	const inlineInputs = isPlainObject(step.inputs) ? (step.inputs as Record<string, unknown>) : null;
	// ADR 0001 Option C — lower structural `{$ref}` handles before the Mapper.
	const nodeConfig: InternalNodeConfig | null = inlineInputs ? { inputs: lowerRefs(inlineInputs) } : null;

	return { internalStep, nodeConfig };
}

const WAIT_NODE_REF = "@blokjs/wait";

/**
 * PR 4 — normalize a v2 wait step.
 *
 * Wait steps are intercepted by `RunnerSteps` BEFORE `step.process` is
 * invoked (the wait IS the runner-level deferral); the resolved node is
 * a no-op placeholder. The runner reads `waitForMs` / `waitUntil` off
 * the InternalStep to decide how long to wait.
 *
 * A LITERAL `wait.for` (duration string or number) is parsed to milliseconds
 * here via `parseDuration`; a literal `wait.until` is left as-is for the
 * runner's `Number()` / `Date.parse()` pass.
 *
 * #704 — either field may instead be a REFERENCE, which cannot be parsed at
 * load time because no request `ctx` exists yet: a structural `{$ref}` /
 * `{$tpl}` (lowered to the wire format right here — `lowerRefs` runs over step
 * `inputs` at the shared boundary and `wait` is not an inputs position; unify
 * the two if a third such position ever appears) or a hand-written `js/…`
 * escape hatch. Those are carried on `waitForExpr` / `waitUntilExpr` and
 * resolved by `RunnerSteps` when the step executes.
 *
 * A value that is expression-SHAPED but is neither of those (a `$.` proxy
 * path, a bare `ctx.` chain, a `${…}` interpolation) is refused HERE rather than
 * stored as a literal that could never parse as a duration or a date — the
 * same rule the resolved-key fields apply, sharing `unresolvableKeyShape`
 * (#706) so the two can never disagree.
 */
function normalizeWaitStep(step: Record<string, unknown>, index: number): InternalStep {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: wait step at index ${index} is missing \`id\`.`);
	}
	const waitObj = step.wait as { for?: unknown; until?: unknown };
	const hasFor = waitObj.for !== undefined;
	const hasUntil = waitObj.until !== undefined;
	if (hasFor === hasUntil) {
		throw new Error(
			`[blok] WorkflowNormalizer: wait step "${id}" must set exactly one of \`wait.for\` or \`wait.until\`.`,
		);
	}

	let waitForMs: number | undefined;
	let waitUntil: number | string | undefined;
	let waitForExpr: string | undefined;
	let waitUntilExpr: string | undefined;

	if (hasFor) {
		const raw = lowerWaitRef(waitObj.for, id, "wait.for");
		if (typeof raw === "number") {
			waitForMs = raw;
		} else if (typeof raw === "string") {
			if (raw.startsWith(WAIT_EXPR_PREFIX)) waitForExpr = raw;
			// parseDuration may throw on invalid grammar — let it surface.
			else waitForMs = parseDuration(raw);
		} else {
			throw new Error(
				`[blok] WorkflowNormalizer: wait step "${id}" has invalid \`wait.for\` (must be number ms, duration string, {"$ref": …}, or a \`js/\` expression).`,
			);
		}
	}
	if (hasUntil) {
		const raw = lowerWaitRef(waitObj.until, id, "wait.until");
		if (typeof raw !== "number" && typeof raw !== "string") {
			throw new Error(
				`[blok] WorkflowNormalizer: wait step "${id}" has invalid \`wait.until\` (must be number ms, string, {"$ref": …}, or a \`js/\` expression).`,
			);
		}
		if (typeof raw === "string" && raw.startsWith(WAIT_EXPR_PREFIX)) waitUntilExpr = raw;
		else waitUntil = raw;
	}

	const ephemeral = step.ephemeral === true;
	const as = pickString(step.as);

	return {
		name: id,
		node: WAIT_NODE_REF,
		type: "wait",
		active: step.active === undefined ? true : step.active === true,
		stop: step.stop === true,
		as,
		ephemeral,
		waitForMs,
		waitUntil,
		waitForExpr,
		waitUntilExpr,
		...copyStepMeta(step),
	};
}

/** The wire-format prefix a resolved-at-dispatch wait value carries (#704). */
const WAIT_EXPR_PREFIX = "js/";

/**
 * Lower a structural `{$ref}` / `{$tpl}` written in a wait position to the
 * `js/…` wire string, and refuse a value that only LOOKS like an expression.
 *
 * Anything else (number, duration string, ISO date) passes through untouched —
 * the literal fast path is byte-identical to pre-#704.
 */
function lowerWaitRef(raw: unknown, id: string, field: string): unknown {
	const lowered = lowerRefs(raw);
	const shape = unresolvableKeyShape(lowered);
	if (shape) {
		throw new Error(
			[
				`[blok] WorkflowNormalizer: \`${field}\` on wait step "${id}" is ${shape}, which never resolves: ${JSON.stringify(raw)}.`,
				`  This field takes a duration/timestamp literal, a structural {"$ref": {"step", "path"}}, or a \`js/\` expression. Taken as a literal it could never parse as a duration or a date.`,
				`  fix: {"$ref": {"step": "<producing-step>", "path": []}}, or the \`js/\` form (e.g. \`js/ctx.state.backoff\`).`,
			].join("\n"),
		);
	}
	return lowered;
}

// v0.5 forEach reference for the internal step's `node` field.
const FOR_EACH_NODE_REF = "@blokjs/forEach";
const LOOP_NODE_REF = "@blokjs/loop";
const SWITCH_NODE_REF = "@blokjs/switch";
const TRY_CATCH_NODE_REF = "@blokjs/tryCatch";

/**
 * Normalize a v0.5 forEach step into the internal shape. Inner steps
 * are recursively normalized via `normalizeRegularStep` so they get
 * their inputs inlined; their nodeConfigs bubble up via `innerNodes`
 * for the top-level `internalNodes` map (same pattern as branch).
 */
function normalizeForEachStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig; innerNodes: Record<string, InternalNodeConfig> } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: forEach step at index ${index} is missing \`id\`.`);
	}
	const fe = step.forEach as Record<string, unknown>;
	const inField = fe.in;
	if (inField === undefined) {
		throw new Error(`[blok] WorkflowNormalizer: forEach step "${id}" is missing \`in\`.`);
	}
	const as = pickString(fe.as);
	if (!as) {
		throw new Error(`[blok] WorkflowNormalizer: forEach step "${id}" is missing \`as\` (per-iteration variable name).`);
	}
	const mode = fe.mode === "parallel" ? "parallel" : "sequential";
	const concurrency = typeof fe.concurrency === "number" && fe.concurrency > 0 ? fe.concurrency : 10;
	const doSteps = Array.isArray(fe.do) ? (fe.do as unknown[]) : [];

	// v0.6 Phase 3 — parallel forEach + wait composition warning. When
	// a wait fires inside a parallel iteration, peer in-flight iterations
	// are cancelled and re-launched on resume. Re-launches re-execute
	// side effects unless inner steps have `idempotencyKey` (or are
	// naturally side-effect-free). This is a per-author-contract gotcha
	// (see `docs/c/devtools/parallel-foreach-wait-spec.mdx#author-contract`).
	// Warn at load time so authors notice; don't BLOCK the workflow —
	// some authors deliberately accept the retry behavior (e.g. pure
	// fetches) or have their own idempotency layer.
	if (mode === "parallel" && doStepsContainWait(doSteps)) {
		const nonIdempotentInnerSteps = doSteps
			.filter((s): s is Record<string, unknown> => isPlainObject(s))
			.filter((s) => !isWaitStep(s) && s.idempotencyKey === undefined)
			.map((s) => pickString(s.id) ?? "(unnamed)");
		if (nonIdempotentInnerSteps.length > 0) {
			const stepList = nonIdempotentInnerSteps.map((n) => `"${n}"`).join(", ");
			console.warn(
				`[blok][normalizer] forEach "${id}" runs in parallel mode with a wait inside the iteration body. When the wait fires, peer iterations are cancelled and re-launched from scratch on resume. Inner steps without an \`idempotencyKey\` will re-execute their side effects on each re-launch: ${stepList}. Add \`idempotencyKey\` to side-effecting steps, OR confirm the steps are side-effect-free. See docs/c/devtools/parallel-foreach-wait-spec.mdx for the author contract.`,
			);
		}
	}

	const { innerInternal, innerNodes } = normalizeStepBlock(doSteps);

	const internalStep: InternalStep = {
		name: id,
		node: FOR_EACH_NODE_REF,
		type: "forEach",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		...copyStepMeta(step),
	};
	// nodeConfig — top-level `steps` triggers Configuration's
	// isFlowWithProperties path which materializes into NodeBase[].
	const nodeConfig: InternalNodeConfig = {
		in: inField,
		as,
		mode,
		concurrency,
		steps: innerInternal,
	} as InternalNodeConfig;

	return { internalStep, nodeConfig, innerNodes };
}

/**
 * v0.6 Phase 3 — recognise a wait step in the raw (pre-normalization)
 * shape. Two encodings: v0.5 `{ id, wait: {for|until} }` OR legacy
 * `{ id, type: "wait", waitForMs|waitUntil }`. Used by
 * `normalizeForEachStep` to emit the parallel + wait warning.
 */
function isWaitStep(step: Record<string, unknown>): boolean {
	if (isPlainObject(step.wait)) return true;
	if (step.type === "wait") return true;
	return false;
}

/**
 * v0.6 Phase 3 — scan the doSteps array (one level deep) for a wait
 * step. Doesn't recurse into nested primitives (forEach inside forEach,
 * tryCatch inside forEach) — those are out of scope for this warning;
 * Phase 4 nested-primitive work will extend.
 */
function doStepsContainWait(doSteps: unknown[]): boolean {
	for (const s of doSteps) {
		if (isPlainObject(s) && isWaitStep(s)) return true;
	}
	return false;
}

/**
 * Normalize a v0.5 loop step into the internal shape. Same inner-step
 * propagation pattern as forEach.
 */
function normalizeLoopStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig; innerNodes: Record<string, InternalNodeConfig> } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: loop step at index ${index} is missing \`id\`.`);
	}
	const lp = step.loop as Record<string, unknown>;
	const whileExpr = pickString(lp.while);
	if (!whileExpr) {
		throw new Error(`[blok] WorkflowNormalizer: loop step "${id}" is missing \`while\` (the JS condition string).`);
	}
	const maxIterations = typeof lp.maxIterations === "number" && lp.maxIterations > 0 ? lp.maxIterations : 1000;
	const doSteps = Array.isArray(lp.do) ? (lp.do as unknown[]) : [];

	const { innerInternal, innerNodes } = normalizeStepBlock(doSteps);

	const internalStep: InternalStep = {
		name: id,
		node: LOOP_NODE_REF,
		type: "loop",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		...copyStepMeta(step),
	};
	const nodeConfig: InternalNodeConfig = {
		while: whileExpr,
		maxIterations,
		steps: innerInternal,
	} as InternalNodeConfig;

	return { internalStep, nodeConfig, innerNodes };
}

/**
 * Helper used by `normalizeSwitchStep` — converts an array of authored
 * step shapes (the `do` block of a case or the `default` block) into
 * resolved InternalSteps + a merged innerNodes map. Mirrors the inner
 * loop in `normalizeForEachStep` / `normalizeLoopStep`, recursing into
 * nested branch / forEach / loop / switch as needed.
 */
function normalizeStepBlock(rawSteps: unknown[]): {
	innerInternal: InternalStep[];
	innerNodes: Record<string, InternalNodeConfig>;
} {
	const innerInternal: InternalStep[] = [];
	const innerNodes: Record<string, InternalNodeConfig> = {};

	for (let i = 0; i < rawSteps.length; i++) {
		const s = rawSteps[i];
		if (!isPlainObject(s)) continue;
		if (isPlainObject((s as Record<string, unknown>).branch)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeBranchStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		if (isPlainObject((s as Record<string, unknown>).wait)) {
			const nestedStep = normalizeWaitStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			continue;
		}
		if (isPlainObject((s as Record<string, unknown>).forEach)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeForEachStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		if (isPlainObject((s as Record<string, unknown>).loop)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeLoopStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		if (isPlainObject((s as Record<string, unknown>).switch)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeSwitchStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		if (isPlainObject((s as Record<string, unknown>).tryCatch)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeTryCatchStep(s as Record<string, unknown>, i);
			innerInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		if (typeof (s as Record<string, unknown>).subworkflow === "string") {
			const { internalStep: nestedStep, nodeConfig: nestedConfig } = normalizeSubworkflowStep(
				s as Record<string, unknown>,
				i,
			);
			innerInternal.push(nestedStep);
			if (nestedConfig) innerNodes[nestedStep.name] = nestedConfig;
			continue;
		}
		const { internalStep: regularStep, nodeConfig } = normalizeRegularStep(s as Record<string, unknown>, {}, i);
		if (nodeConfig?.inputs) {
			(regularStep as Record<string, unknown>).inputs = nodeConfig.inputs;
		}
		if (nodeConfig) innerNodes[regularStep.name] = nodeConfig;
		innerInternal.push(regularStep);
	}

	return { innerInternal, innerNodes };
}

/**
 * Normalize a v0.5 switch step into the internal shape. The cases and
 * optional default each carry their own inner-step list — Configuration
 * resolves them via a dedicated branch in `getNodes()` (mirrors the
 * tryCatch path: each sub-block becomes its own resolved Flow).
 *
 * SwitchNode at run time reads the resolved nodeConfig:
 *   { on, cases: [{when, steps: NodeBase[]}], default?: NodeBase[] }
 * and runs the matched case (or default) through a child Runner.
 */
function normalizeSwitchStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig; innerNodes: Record<string, InternalNodeConfig> } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: switch step at index ${index} is missing \`id\`.`);
	}
	const sw = step.switch as Record<string, unknown>;
	if (sw.on === undefined) {
		throw new Error(`[blok] WorkflowNormalizer: switch step "${id}" is missing \`on\` (the value to match against).`);
	}
	const rawCases = Array.isArray(sw.cases) ? (sw.cases as unknown[]) : [];
	if (rawCases.length === 0) {
		throw new Error(`[blok] WorkflowNormalizer: switch step "${id}" has no \`cases\` (need at least one).`);
	}

	const cases: Array<{ when: unknown; steps: InternalStep[] }> = [];
	const innerNodes: Record<string, InternalNodeConfig> = {};

	for (let ci = 0; ci < rawCases.length; ci++) {
		const c = rawCases[ci];
		if (!isPlainObject(c)) {
			throw new Error(`[blok] WorkflowNormalizer: switch step "${id}" cases[${ci}] is not an object.`);
		}
		const cobj = c as Record<string, unknown>;
		if (cobj.when === undefined) {
			throw new Error(`[blok] WorkflowNormalizer: switch step "${id}" cases[${ci}] is missing \`when\`.`);
		}
		const doSteps = Array.isArray(cobj.do) ? (cobj.do as unknown[]) : [];
		const { innerInternal, innerNodes: caseInner } = normalizeStepBlock(doSteps);
		Object.assign(innerNodes, caseInner);
		cases.push({ when: cobj.when, steps: innerInternal });
	}

	let defaultSteps: InternalStep[] | undefined;
	if (Array.isArray(sw.default)) {
		const { innerInternal, innerNodes: defaultInner } = normalizeStepBlock(sw.default as unknown[]);
		Object.assign(innerNodes, defaultInner);
		defaultSteps = innerInternal;
	}

	const internalStep: InternalStep = {
		name: id,
		node: SWITCH_NODE_REF,
		type: "switch",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		...copyStepMeta(step),
	};
	const nodeConfig: InternalNodeConfig = {
		on: sw.on,
		cases,
		...(defaultSteps !== undefined ? { default: defaultSteps } : {}),
	} as InternalNodeConfig;

	return { internalStep, nodeConfig, innerNodes };
}

/**
 * Normalize a v0.5 tryCatch step into the internal shape. Each of `try`,
 * `catch`, and optional `finally` carries its own inner-step list —
 * Configuration resolves them via a dedicated branch in `getNodes()` so
 * each block becomes its own resolved Flow (steps: NodeBase[]).
 *
 * TryCatchNode at run time reads the resolved nodeConfig:
 *   { try: NodeBase[], catch: NodeBase[], finally?: NodeBase[] }
 * and runs them according to JS-like try/catch/finally semantics.
 */
function normalizeTryCatchStep(
	step: Record<string, unknown>,
	index: number,
): { internalStep: InternalStep; nodeConfig: InternalNodeConfig; innerNodes: Record<string, InternalNodeConfig> } {
	const id = pickString(step.id);
	if (!id) {
		throw new Error(`[blok] WorkflowNormalizer: tryCatch step at index ${index} is missing \`id\`.`);
	}
	const tc = step.tryCatch as Record<string, unknown>;
	if (!Array.isArray(tc.try) || (tc.try as unknown[]).length === 0) {
		throw new Error(`[blok] WorkflowNormalizer: tryCatch step "${id}" requires a non-empty \`try\` block.`);
	}
	if (!Array.isArray(tc.catch) || (tc.catch as unknown[]).length === 0) {
		throw new Error(`[blok] WorkflowNormalizer: tryCatch step "${id}" requires a non-empty \`catch\` block.`);
	}

	const innerNodes: Record<string, InternalNodeConfig> = {};

	const tryBlock = normalizeStepBlock(tc.try as unknown[]);
	Object.assign(innerNodes, tryBlock.innerNodes);

	const catchBlock = normalizeStepBlock(tc.catch as unknown[]);
	Object.assign(innerNodes, catchBlock.innerNodes);

	let finallyBlock: { innerInternal: InternalStep[]; innerNodes: Record<string, InternalNodeConfig> } | undefined;
	if (Array.isArray(tc.finally)) {
		finallyBlock = normalizeStepBlock(tc.finally as unknown[]);
		Object.assign(innerNodes, finallyBlock.innerNodes);
	}

	const internalStep: InternalStep = {
		name: id,
		node: TRY_CATCH_NODE_REF,
		type: "tryCatch",
		active: step.active === undefined ? true : Boolean(step.active),
		stop: step.stop === true,
		...copyStepMeta(step),
	};
	const nodeConfig: InternalNodeConfig = {
		try: tryBlock.innerInternal,
		catch: catchBlock.innerInternal,
		...(finallyBlock !== undefined ? { finally: finallyBlock.innerInternal } : {}),
	} as InternalNodeConfig;

	return { internalStep, nodeConfig, innerNodes };
}

function normalizeTrigger(rawTrigger: unknown, sourcePath?: string): Record<string, unknown> {
	if (!isPlainObject(rawTrigger)) return {};
	const out: Record<string, unknown> = {};
	for (const [kind, cfg] of Object.entries(rawTrigger as Record<string, unknown>)) {
		if (!isPlainObject(cfg)) {
			out[kind] = cfg;
			continue;
		}
		const triggerCfg = lowerTriggerKeys(cfg as Record<string, unknown>);
		if (kind === "http" && triggerCfg.method === "*") {
			triggerCfg.method = "ANY";
			warnWildcardOnce(sourcePath);
		}
		out[kind] = triggerCfg;
	}
	return out;
}

/**
 * #707 (from #715's finding) — lower the two TRIGGER-side resolved-key
 * positions, `concurrencyKey` and `debounce.key`.
 *
 * These are not Mapper-resolved: the runner evaluates a `js/` string and takes
 * any other string as a LITERAL key. Lowering was previously applied to step
 * `inputs` only, so a structural `{$ref}` here reached `resolveKey` as a raw
 * object — which #706's guard now refuses loudly rather than silently
 * collapsing every tenant into one bucket. Lowering makes the structural form
 * WORK; the guard stays as the backstop for anything that bypasses this pass.
 *
 * Only these two fields are touched. A blanket `lowerRefs(cfg)` would also
 * rewrite non-resolved positions (`path`, `middleware`, …) into `js/…` strings
 * nothing evaluates — trading one silent miscompile for another.
 */
function lowerTriggerKeys(cfg: Record<string, unknown>): Record<string, unknown> {
	const out = { ...cfg };
	if (out.concurrencyKey !== undefined) out.concurrencyKey = lowerRefs(out.concurrencyKey);
	if (isPlainObject(out.debounce) && (out.debounce as Record<string, unknown>).key !== undefined) {
		const debounce = { ...(out.debounce as Record<string, unknown>) };
		debounce.key = lowerRefs(debounce.key);
		out.debounce = debounce;
	}
	return out;
}

function inferStepType(nodeRef: string): string {
	// Explicit runtime prefixes — `runtime.python3:my-node` style.
	if (nodeRef.startsWith("runtime.")) {
		const dotIdx = nodeRef.indexOf(":");
		if (dotIdx > 0) return nodeRef.slice(0, dotIdx);
		return nodeRef;
	}
	// Default to module — covers `@blokjs/*` and most user-defined nodes.
	return "module";
}

function warnWildcardOnce(sourcePath?: string): void {
	const key = sourcePath ?? "<unknown>";
	if (_wildcardWarnedFiles.has(key)) return;
	_wildcardWarnedFiles.add(key);
	console.warn(
		`[blok] trigger.http.method "*" is deprecated; use "ANY" instead. (workflow: ${key}). Run \`blokctl migrate workflows\` to update.`,
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || value === undefined) return false;
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Spread the AUTHORING metadata an InternalStep carries but the runner never
 * executes: `ui` (canvas position/notes, #301) and `description` (#713).
 *
 * Both are accepted by all 8 v2 step schemas and both are pure round-trip
 * concerns — Studio normalizes a workflow and serializes it straight back out,
 * so a field the normalizer drops is a field the author loses on save. Applied
 * in every InternalStep constructor (incl. the nested inner-step builders) so
 * they survive at any depth, in any arm.
 */
function copyStepMeta(step: Record<string, unknown>): { ui?: Record<string, unknown>; description?: string } {
	return {
		...(isPlainObject(step.ui) ? { ui: step.ui } : {}),
		...(typeof step.description === "string" ? { description: step.description } : {}),
	};
}

/**
 * Read one of the three RESOLVED-KEY positions (`idempotencyKey`,
 * `concurrencyKey`, `debounce.key`), lowering a structural `{$ref}` / `{$tpl}`
 * into the `js/…` string the runner evaluates first (#707).
 *
 * Order matters: the old code type-checked BEFORE lowering, so a structural ref
 * here was not merely unlowered — it failed `typeof === "string"` and was
 * DROPPED, silently disabling the idempotency cache for that step.
 */
/**
 * Copy a step's `retry` block onto the internal step. Shared by the regular and
 * subworkflow paths — they used to hold byte-identical copies, which is how
 * `nonRetryableErrorNames` came to be validated by the v2 schema and honoured by
 * `RunnerSteps` yet dropped by BOTH copies, leaving selective retry dead end to
 * end (#679). One reader now, so a new field can only be forgotten once.
 *
 * `maxAttempts` is required: a block without an integer one is ignored entirely.
 */
function pickRetryConfig(raw: unknown): RetryConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (typeof raw.maxAttempts !== "number" || !Number.isInteger(raw.maxAttempts)) return undefined;
	const retry: RetryConfig = { maxAttempts: raw.maxAttempts };
	if (typeof raw.minTimeoutInMs === "number") retry.minTimeoutInMs = raw.minTimeoutInMs;
	if (typeof raw.maxTimeoutInMs === "number") retry.maxTimeoutInMs = raw.maxTimeoutInMs;
	if (typeof raw.factor === "number") retry.factor = raw.factor;
	if (Array.isArray(raw.nonRetryableErrorNames)) {
		const names = raw.nonRetryableErrorNames.filter((n): n is string => typeof n === "string" && n.length > 0);
		if (names.length > 0) retry.nonRetryableErrorNames = names;
	}
	return retry;
}

function pickResolvedKey(value: unknown): string | undefined {
	return pickString(lowerRefs(value));
}

/**
 * #707 — the total post-normalize invariant: NO structural `{$ref}` / `{$tpl}`
 * may reach the runner.
 *
 * `lowerRefs` compiles those sentinels into the wire strings the Mapper
 * resolves (ADR 0001 Option C). Anything it misses is not an error the runtime
 * reports — the Mapper walks INTO the plain object, string-resolves its inner
 * `step`/`path` fields, and hands the node a raw `{"$ref": {...}}` where a
 * value belongs. Silent miscompile, the worst class. So the load boundary
 * asserts the absence rather than trusting every emission site to remember.
 *
 * It fires on two real classes:
 *   1. a lowering site added later that forgets the pass (regression guard);
 *   2. a ref written in a position lowering deliberately does NOT cover —
 *      `forEach.in`, `switch.on`, a `switch` case `when`. Those take a path
 *      STRING (the TS DSL already lowers its handles there at authoring time,
 *      see `stepBuilder.lowerHandleToInExpr`), so a hand-written JSON `{$ref}`
 *      there has always been broken. Now it is loud.
 *
 * Traversal mirrors `lowerRefs` exactly — plain objects and arrays only, so a
 * Zod schema or any class instance is stepped over, not walked. `input` /
 * `output` / `events` are excluded for the same reason plus one of their own:
 * a JSON Schema legitimately contains `{"$ref": "#/definitions/…"}`, which is
 * not a structural ref (its `$ref` is a string) but is not ours to police.
 *
 * `wait.for` / `wait.until` are literal positions, not ref positions (#704
 * owns any change there); they are numbers/strings by the time they get here
 * and the walk simply passes over them.
 */
function assertNoUnloweredRefs(workflow: InternalWorkflow, sourcePath?: string): void {
	walkForUnloweredRefs(workflow.trigger, "trigger", "<trigger>", sourcePath);
	workflow.steps.forEach((step, i) => walkForUnloweredRefs(step, `steps[${i}]`, step.name, sourcePath));
	for (const [key, config] of Object.entries(workflow.nodes)) {
		walkForUnloweredRefs(config, `nodes[${JSON.stringify(key)}]`, key, sourcePath);
	}
}

function walkForUnloweredRefs(value: unknown, docPath: string, stepId: string, sourcePath?: string): void {
	if (value === null || value === undefined || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((item, i) => walkForUnloweredRefs(item, `${docPath}[${i}]`, stepId, sourcePath));
		return;
	}
	// Same plain-object rule `lowerRefs` uses — a class instance is opaque to
	// the pass, so it must be opaque to the assertion too.
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return;

	if (isStructuralRef(value) || isStructuralTpl(value)) {
		const kind = isStructuralRef(value) ? "$ref" : "$tpl";
		const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
		throw new Error(
			`[blok] WorkflowNormalizer: a structural \`{${kind}}\` survived normalization at ${docPath} (step "${stepId}"). Only step \`inputs\` and the resolved-key fields (\`idempotencyKey\`, \`concurrencyKey\`, \`debounce.key\`) are lowered to the \`js/…\` wire form the runtime resolves; everywhere else the Mapper would walk INTO the object and hand the node a raw \`{"${kind}": …}\` instead of the value. Control positions (\`forEach.in\`, \`switch.on\`, a \`switch\` case \`when\`, \`branch.when\`, \`loop.while\`) take a path string or a literal — write the path directly.${suffix}`,
		);
	}

	// A nested step object re-roots the reported id (inner arms carry `name`).
	const nestedId = typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : stepId;
	for (const [key, child] of Object.entries(value)) {
		walkForUnloweredRefs(child, `${docPath}.${key}`, nestedId, sourcePath);
	}
}

/**
 * Test-only — reset the per-process wildcard warning cache.
 *
 * @internal
 */
export function _resetWildcardWarningCache(): void {
	_wildcardWarnedFiles = new Set<string>();
}

/**
 * Test-only — reset the per-process legacy-expression warning cache.
 *
 * @internal
 */
export function _resetLegacyExprWarningCache(): void {
	_legacyExprWarnedFiles = new Set<string>();
}

/**
 * A step input written as a bare `js/` path with an exact structural
 * equivalent — `js/ctx.state.<key>…`, `js/ctx.request…`, `js/ctx.prev…`,
 * `js/ctx.error…` and their `vars`/`req`/`response` aliases, with only
 * `.ident`, `[0]` and `["quoted"]` accessors after the root.
 *
 * Deliberately NARROW. Anything with an operator, a call, a fallback or a
 * template literal is the sanctioned `js` escape hatch (ADR 0008) and has no
 * structural form, so nagging about it would be noise. This regex matches
 * exactly the set the field-aware ref codemod can rewrite, which is what makes
 * the warning's "run `blokctl migrate refs`" advice true.
 */
const PURE_PATH_EXPR =
	/^js\/(?:ctx|\$)\.(?:state|vars|request|req|prev|response|error)(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\['[^']*'\]|\["[^"]*"\])*$/;

/** Recursively count pure-path `js/` strings inside one step's `inputs`. */
function countLegacyInputExprs(value: unknown): number {
	if (typeof value === "string") return PURE_PATH_EXPR.test(value) ? 1 : 0;
	if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countLegacyInputExprs(v), 0);
	if (!isPlainObject(value)) return 0;
	return Object.values(value).reduce<number>((n, v) => n + countLegacyInputExprs(v), 0);
}

/**
 * Walk the raw step tree collecting `{ stepId, count }` for every step whose
 * `inputs` still carry pure-path `js/` strings. Descends into every
 * sub-pipeline so a legacy input nested three arms deep is still reported.
 */
function collectLegacyExprSteps(steps: readonly unknown[], out: { id: string; count: number }[]): void {
	for (const raw of steps) {
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		const count = countLegacyInputExprs(step.inputs);
		if (count > 0) out.push({ id: pickString(step.id) ?? pickString(step.name) ?? "(unnamed)", count });

		if (isPlainObject(step.branch)) {
			const b = step.branch as Record<string, unknown>;
			if (Array.isArray(b.then)) collectLegacyExprSteps(b.then, out);
			if (Array.isArray(b.else)) collectLegacyExprSteps(b.else, out);
		}
		for (const key of ["forEach", "loop"] as const) {
			const block = step[key];
			if (isPlainObject(block) && Array.isArray((block as Record<string, unknown>).do)) {
				collectLegacyExprSteps((block as Record<string, unknown>).do as unknown[], out);
			}
		}
		if (isPlainObject(step.tryCatch)) {
			const tc = step.tryCatch as Record<string, unknown>;
			for (const arm of ["try", "catch", "finally"] as const) {
				if (Array.isArray(tc[arm])) collectLegacyExprSteps(tc[arm] as unknown[], out);
			}
		}
		if (isPlainObject(step.switch)) {
			const sw = step.switch as Record<string, unknown>;
			if (Array.isArray(sw.default)) collectLegacyExprSteps(sw.default, out);
			if (Array.isArray(sw.cases)) {
				for (const c of sw.cases) {
					if (!isPlainObject(c)) continue;
					const cc = c as Record<string, unknown>;
					if (Array.isArray(cc.steps)) collectLegacyExprSteps(cc.steps, out);
					if (Array.isArray(cc.do)) collectLegacyExprSteps(cc.do, out);
				}
			}
		}
	}
}

/**
 * #690 — one structured deprecation warning per workflow when its step inputs
 * still hold hand-written `js/` path strings instead of structural `{$ref}`
 * handles. Fires at LOAD time (once per workflow, keyed like the `"*"`-method
 * warning), never per request, and is silent for a workflow whose inputs are
 * already structural — `{$ref}` / `{$tpl}` nodes are objects, not strings.
 *
 * Silence with `BLOK_SUPPRESS_LEGACY_EXPR_WARNING=1` (CI escape hatch).
 * Removal target for the accepted-but-deprecated form: next major.
 */
function warnLegacyExpressionsOnce(steps: readonly unknown[], name: string, sourcePath?: string): void {
	const suppress = process.env.BLOK_SUPPRESS_LEGACY_EXPR_WARNING;
	if (suppress === "1" || suppress === "true") return;

	const key = sourcePath ?? name ?? "<unknown>";
	if (_legacyExprWarnedFiles.has(key)) return;

	const offenders: { id: string; count: number }[] = [];
	collectLegacyExprSteps(steps, offenders);
	if (offenders.length === 0) return;

	_legacyExprWarnedFiles.add(key);
	const total = offenders.reduce((n, o) => n + o.count, 0);
	const stepList = offenders.map((o) => `${o.id} (${o.count})`).join(", ");
	const where = sourcePath ? ` (${sourcePath})` : "";
	console.warn(
		[
			`[blok][deprecated] workflow "${name || key}"${where} has ${total} step input(s) written as legacy \`js/\` expression strings across ${offenders.length} step(s): ${stepList}.`,
			'These are the runtime wire format, not an authoring form — use structural `{"$ref": {"step", "path"}}` handles instead.',
			"Run `blokctl migrate refs` to rewrite them. See docs/c/migration-guides/legacy-expression-strings.mdx.",
			"Support for hand-written `js/` inputs will be removed in the next major.",
			"Set BLOK_SUPPRESS_LEGACY_EXPR_WARNING=1 to silence.",
		].join(" "),
	);
}

/**
 * `set_var` is no longer accepted on workflow steps. Walk the raw step
 * tree (top-level steps + every nested sub-pipeline) and throw with a
 * migration hint on the first occurrence. The walk handles branch,
 * forEach, loop, switch, and tryCatch sub-pipelines so a rejected
 * field at any depth is caught at load time rather than after the
 * partial-normalization point.
 */
/**
 * Step ids must be unique across the ENTIRE workflow — including across
 * mutually-exclusive branch/switch arms — because every step shares ONE flat
 * per-workflow config map. A collision silently runs a step with another
 * step's inputs (the matched arm runs with the other arm's config). Walk the
 * raw step tree (same nesting as `assertNoSetVar`) with a shared `seen` set
 * and throw on the first duplicate, at load time.
 */
function assertNoDuplicateStepIds(
	steps: unknown[],
	sourcePath?: string,
	seen: Map<string, string> = new Map(),
	path = "steps",
): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		const stepPath = `${path}[${i}]`;
		const id = pickString(step.id) ?? pickString(step.name);
		if (id) {
			const firstPath = seen.get(id);
			if (firstPath !== undefined) {
				const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
				throw new Error(
					`[blok] WorkflowNormalizer: duplicate step id "${id}" at ${stepPath}; first seen at ${firstPath}. Step ids must be unique across the whole workflow — including across mutually-exclusive branch/switch arms — because all steps share one flat per-workflow config map, so a collision silently runs a step with another step's inputs. If two arms must write the same downstream state key, use \`as:\` with unique ids (e.g. { id: "runA", as: "run" } / { id: "runB", as: "run" }).${suffix}`,
				);
			}
			seen.set(id, stepPath);
		}
		// Recurse into nested sub-pipelines — same shape as assertNoSetVar.
		if (isPlainObject(step.branch)) {
			const branch = step.branch as { then?: unknown; else?: unknown };
			if (Array.isArray(branch.then)) {
				assertNoDuplicateStepIds(branch.then as unknown[], sourcePath, seen, `${stepPath}.branch.then`);
			}
			if (Array.isArray(branch.else)) {
				assertNoDuplicateStepIds(branch.else as unknown[], sourcePath, seen, `${stepPath}.branch.else`);
			}
		}
		if (isPlainObject(step.forEach)) {
			const fe = step.forEach as { do?: unknown };
			if (Array.isArray(fe.do)) {
				assertNoDuplicateStepIds(fe.do as unknown[], sourcePath, seen, `${stepPath}.forEach.do`);
			}
		}
		if (isPlainObject(step.loop)) {
			const lp = step.loop as { do?: unknown };
			if (Array.isArray(lp.do)) {
				assertNoDuplicateStepIds(lp.do as unknown[], sourcePath, seen, `${stepPath}.loop.do`);
			}
		}
		if (isPlainObject(step.switch)) {
			const sw = step.switch as { cases?: unknown; default?: unknown };
			if (Array.isArray(sw.cases)) {
				for (let ci = 0; ci < sw.cases.length; ci++) {
					const c = sw.cases[ci];
					if (isPlainObject(c) && Array.isArray((c as { do?: unknown }).do)) {
						assertNoDuplicateStepIds(
							(c as { do: unknown[] }).do,
							sourcePath,
							seen,
							`${stepPath}.switch.cases[${ci}].do`,
						);
					}
				}
			}
			if (Array.isArray(sw.default)) {
				assertNoDuplicateStepIds(sw.default as unknown[], sourcePath, seen, `${stepPath}.switch.default`);
			}
		}
		if (isPlainObject(step.tryCatch)) {
			const tc = step.tryCatch as { try?: unknown; catch?: unknown; finally?: unknown };
			if (Array.isArray(tc.try)) {
				assertNoDuplicateStepIds(tc.try as unknown[], sourcePath, seen, `${stepPath}.tryCatch.try`);
			}
			if (Array.isArray(tc.catch)) {
				assertNoDuplicateStepIds(tc.catch as unknown[], sourcePath, seen, `${stepPath}.tryCatch.catch`);
			}
			if (Array.isArray(tc.finally)) {
				assertNoDuplicateStepIds(tc.finally as unknown[], sourcePath, seen, `${stepPath}.tryCatch.finally`);
			}
		}
	}
}

function assertNoForEachStateKeyCollisions(steps: unknown[], sourcePath?: string): void {
	const stepIds = new Map<string, string>();
	collectStepIds(steps, stepIds, "steps");
	checkForEachStateKeys(steps, stepIds, [], "steps", sourcePath);
}

function collectStepIds(steps: unknown[], out: Map<string, string>, path: string): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		const stepPath = `${path}[${i}]`;
		const id = pickString(step.id) ?? pickString(step.name);
		if (id && !out.has(id)) out.set(id, stepPath);
		// `as:` redirects a step's output to state[as] — that slot can collide
		// with a forEach iteration handle too, so reserve it as well.
		const as = pickString(step.as);
		if (as && !out.has(as)) out.set(as, `${stepPath}.as`);
		for (const block of childStepBlocks(step, stepPath)) {
			collectStepIds(block.steps, out, block.path);
		}
	}
}

function checkForEachStateKeys(
	steps: unknown[],
	stepIds: Map<string, string>,
	ancestorKeys: Array<{ name: string; path: string }>,
	path: string,
	sourcePath?: string,
): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		const stepPath = `${path}[${i}]`;
		const nextAncestors = [...ancestorKeys];
		if (isPlainObject(step.forEach)) {
			const fe = step.forEach as Record<string, unknown>;
			const as = pickString(fe.as);
			if (as) {
				for (const key of [
					{ name: as, path: `${stepPath}.forEach.as` },
					{ name: `${as}Index`, path: `${stepPath}.forEach.as + "Index"` },
				]) {
					const stepIdPath = stepIds.get(key.name);
					if (stepIdPath !== undefined) {
						const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
						throw new Error(
							`[blok] WorkflowNormalizer: forEach state key "${key.name}" at ${key.path} collides with step id "${key.name}" at ${stepIdPath}. forEach iteration variables share ctx.state with step outputs; rename \`as\` or the step id. If a step needs a shared downstream state key, give it a unique id and use \`as:\`.${suffix}`,
						);
					}
					const ancestor = ancestorKeys.find((candidate) => candidate.name === key.name);
					if (ancestor) {
						const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
						throw new Error(
							`[blok] WorkflowNormalizer: forEach state key "${key.name}" at ${key.path} collides with surrounding forEach state key at ${ancestor.path}. Nested forEach item handles share the same ctx.state namespace; choose a distinct \`as\` name.${suffix}`,
						);
					}
					nextAncestors.push(key);
				}
			}
		}
		for (const block of childStepBlocks(step, stepPath)) {
			checkForEachStateKeys(block.steps, stepIds, nextAncestors, block.path, sourcePath);
		}
	}
}

function childStepBlocks(step: Record<string, unknown>, stepPath: string): Array<{ steps: unknown[]; path: string }> {
	const blocks: Array<{ steps: unknown[]; path: string }> = [];
	if (isPlainObject(step.branch)) {
		const branch = step.branch as { then?: unknown; else?: unknown };
		if (Array.isArray(branch.then)) blocks.push({ steps: branch.then, path: `${stepPath}.branch.then` });
		if (Array.isArray(branch.else)) blocks.push({ steps: branch.else, path: `${stepPath}.branch.else` });
	}
	if (isPlainObject(step.forEach)) {
		const fe = step.forEach as { do?: unknown };
		if (Array.isArray(fe.do)) blocks.push({ steps: fe.do, path: `${stepPath}.forEach.do` });
	}
	if (isPlainObject(step.loop)) {
		const lp = step.loop as { do?: unknown };
		if (Array.isArray(lp.do)) blocks.push({ steps: lp.do, path: `${stepPath}.loop.do` });
	}
	if (isPlainObject(step.switch)) {
		const sw = step.switch as { cases?: unknown; default?: unknown };
		if (Array.isArray(sw.cases)) {
			for (let ci = 0; ci < sw.cases.length; ci++) {
				const c = sw.cases[ci];
				if (isPlainObject(c) && Array.isArray((c as { do?: unknown }).do)) {
					blocks.push({ steps: (c as { do: unknown[] }).do, path: `${stepPath}.switch.cases[${ci}].do` });
				}
			}
		}
		if (Array.isArray(sw.default)) blocks.push({ steps: sw.default, path: `${stepPath}.switch.default` });
	}
	if (isPlainObject(step.tryCatch)) {
		const tc = step.tryCatch as { try?: unknown; catch?: unknown; finally?: unknown };
		if (Array.isArray(tc.try)) blocks.push({ steps: tc.try, path: `${stepPath}.tryCatch.try` });
		if (Array.isArray(tc.catch)) blocks.push({ steps: tc.catch, path: `${stepPath}.tryCatch.catch` });
		if (Array.isArray(tc.finally)) blocks.push({ steps: tc.finally, path: `${stepPath}.tryCatch.finally` });
	}
	return blocks;
}

/**
 * Reject only GENUINE DSL conflicts — never the canonical `{id, node}` hybrid
 * (id = step identity, node = a v1 ref the normalizer maps to `use`), which the
 * whole corpus + real workflows freely mix. A conflict is two fields on the
 * SAME axis competing for one slot:
 *   - `name` AND `id`  → two identities (which one is the step id?)
 *   - `node` AND `use` → two node refs (which node actually runs?)
 * Plus the envelope-level contradiction: an explicit `schemaVersion: "2"` (a v2
 * file) still carrying the legacy top-level `nodes{}` map (half-migrated).
 *
 * This is the narrow successor to the reverted #391 `assertWorkflowDslMode`,
 * which wrongly flagged `{id, node}` as "mixed mode" and broke every
 * SSE/WS/HTTP/MCP trigger workflow (green→red across 4 suites). See #391/#392.
 */
function assertNoConflictingStepDsl(wf: Record<string, unknown>, sourcePath?: string): void {
	const isExplicitV2 = wf.schemaVersion === "2" || wf.schemaVersion === 2;
	if (isExplicitV2 && isPlainObject(wf.nodes) && Object.keys(wf.nodes).length > 0) {
		throwDslConflict(
			'`schemaVersion: "2"` workflow carries the legacy top-level `nodes{}` map — inline the node inputs onto each step and drop `nodes{}`',
			sourcePath,
		);
	}
	const steps = Array.isArray(wf.steps) ? (wf.steps as unknown[]) : [];
	assertNoConflictingStepDslInSteps(steps, "steps", sourcePath);
}

function assertNoConflictingStepDslInSteps(steps: unknown[], path: string, sourcePath?: string): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		const stepPath = `${path}[${i}]`;
		if (step.name !== undefined && step.id !== undefined) {
			throwDslConflict(
				`step at ${stepPath} sets BOTH \`name\` (v1 identity) and \`id\` (v2 identity) — keep one`,
				sourcePath,
			);
		}
		if (step.node !== undefined && step.use !== undefined) {
			throwDslConflict(`step at ${stepPath} sets BOTH \`node\` (v1 ref) and \`use\` (v2 ref) — keep one`, sourcePath);
		}
		for (const block of childStepBlocks(step, stepPath)) {
			assertNoConflictingStepDslInSteps(block.steps, block.path, sourcePath);
		}
	}
}

function throwDslConflict(reason: string, sourcePath?: string): never {
	const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
	throw new Error(
		`[blok] WorkflowNormalizer: conflicting workflow DSL fields: ${reason}. A step may freely use the \`{id, node}\` hybrid (v2 id + v1 ref), but must not set two fields competing for the same slot.${suffix}`,
	);
}

function assertNoSetVar(steps: unknown[], sourcePath?: string): void {
	for (const raw of steps) {
		if (!isPlainObject(raw)) continue;
		const step = raw as Record<string, unknown>;
		if (Object.prototype.hasOwnProperty.call(step, "set_var")) {
			const id = pickString(step.id) ?? pickString(step.name) ?? "<unnamed>";
			const suffix = sourcePath ? ` (file: ${sourcePath})` : "";
			throw new Error(
				`[blok] WorkflowNormalizer: step "${id}" uses \`set_var\`, which was removed in v0.5. Replace \`set_var: false\` with \`ephemeral: true\` and drop \`set_var: true\` (v2 default-stores every step's output). Run \`blokctl migrate workflows\` to convert v1 workflows automatically.${suffix}`,
			);
		}
		// Recurse into nested sub-pipelines.
		if (isPlainObject(step.branch)) {
			const branch = step.branch as { then?: unknown; else?: unknown };
			if (Array.isArray(branch.then)) assertNoSetVar(branch.then as unknown[], sourcePath);
			if (Array.isArray(branch.else)) assertNoSetVar(branch.else as unknown[], sourcePath);
		}
		if (isPlainObject(step.forEach)) {
			const fe = step.forEach as { do?: unknown };
			if (Array.isArray(fe.do)) assertNoSetVar(fe.do as unknown[], sourcePath);
		}
		if (isPlainObject(step.loop)) {
			const lp = step.loop as { do?: unknown };
			if (Array.isArray(lp.do)) assertNoSetVar(lp.do as unknown[], sourcePath);
		}
		if (isPlainObject(step.switch)) {
			const sw = step.switch as { cases?: unknown; default?: unknown };
			if (Array.isArray(sw.cases)) {
				for (const c of sw.cases as unknown[]) {
					if (isPlainObject(c) && Array.isArray((c as { do?: unknown }).do)) {
						assertNoSetVar((c as { do: unknown[] }).do, sourcePath);
					}
				}
			}
			if (Array.isArray(sw.default)) assertNoSetVar(sw.default as unknown[], sourcePath);
		}
		if (isPlainObject(step.tryCatch)) {
			const tc = step.tryCatch as { try?: unknown; catch?: unknown; finally?: unknown };
			if (Array.isArray(tc.try)) assertNoSetVar(tc.try as unknown[], sourcePath);
			if (Array.isArray(tc.catch)) assertNoSetVar(tc.catch as unknown[], sourcePath);
			if (Array.isArray(tc.finally)) assertNoSetVar(tc.finally as unknown[], sourcePath);
		}
	}
}
