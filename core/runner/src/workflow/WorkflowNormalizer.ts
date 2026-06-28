import { parseDuration } from "@blokjs/helper";

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

interface RetryConfig {
	maxAttempts: number;
	minTimeoutInMs?: number;
	maxTimeoutInMs?: number;
	factor?: number;
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
	 * ms-since-epoch OR string for $-proxy / ISO).
	 *
	 * `wait?: boolean` above is the sub-workflow `wait: true|false` flag
	 * — separate concern, separate field.
	 */
	waitForMs?: number;
	waitUntil?: number | string;
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
	}
	const name = typeof wf.name === "string" ? wf.name : "";
	const version = typeof wf.version === "string" ? wf.version : "1.0.0";
	const description = typeof wf.description === "string" ? wf.description : undefined;
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
	// (rare, but possible for legacy workflows with helper sub-flows
	// declared at the top level)
	for (const key of Object.keys(nodesInput)) {
		if (internalNodes[key] !== undefined) continue;
		const value = nodesInput[key];
		if (isPlainObject(value)) {
			internalNodes[key] = value as InternalNodeConfig;
		}
	}

	return {
		name,
		version,
		description,
		trigger,
		steps: internalSteps,
		nodes: internalNodes,
		...(middleware ? { middleware } : {}),
		...(appliedMiddleware ? { appliedMiddleware } : {}),
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(events !== undefined ? { events } : {}),
	};
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
	if (typeof step.idempotencyKey === "string" && step.idempotencyKey.length > 0) {
		internalStep.idempotencyKey = step.idempotencyKey;
	}
	if (typeof step.idempotencyKeyTTL === "number" && Number.isFinite(step.idempotencyKeyTTL)) {
		internalStep.idempotencyKeyTTL = step.idempotencyKeyTTL;
	}
	if (isPlainObject(step.retry)) {
		const r = step.retry as Record<string, unknown>;
		if (typeof r.maxAttempts === "number" && Number.isInteger(r.maxAttempts)) {
			const retry: RetryConfig = { maxAttempts: r.maxAttempts };
			if (typeof r.minTimeoutInMs === "number") retry.minTimeoutInMs = r.minTimeoutInMs;
			if (typeof r.maxTimeoutInMs === "number") retry.maxTimeoutInMs = r.maxTimeoutInMs;
			if (typeof r.factor === "number") retry.factor = r.factor;
			internalStep.retry = retry;
		}
	}
	if (typeof step.maxDuration === "number" || typeof step.maxDuration === "string") {
		internalStep.maxDuration = step.maxDuration;
	}

	// Build node config — only include `inputs` if present.
	let nodeConfig: InternalNodeConfig | null = null;
	if (inputs) {
		nodeConfig = { inputs };
		// Carry over any legacy v1 node-config fields that aren't `inputs`
		// (some workflows attach `outputs`, `mapper`, etc.).
		if (v1NodeConfig) {
			for (const k of Object.keys(v1NodeConfig)) {
				if (k === "inputs") continue;
				nodeConfig[k] = (v1NodeConfig as Record<string, unknown>)[k];
			}
		}
	} else if (v1NodeConfig) {
		nodeConfig = { ...v1NodeConfig };
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

	// Normalize each branch's nested steps recursively. Use empty
	// `nodesInput` because v2 branches inline `inputs` on each nested step.
	const thenInternal: InternalStep[] = [];
	const elseInternal: InternalStep[] = [];
	const innerNodes: Record<string, InternalNodeConfig> = {};

	for (let i = 0; i < thenSteps.length; i++) {
		const s = thenSteps[i];
		if (!isPlainObject(s)) continue;
		if (isPlainObject((s as Record<string, unknown>).branch)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeBranchStep(s as Record<string, unknown>, i);
			thenInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		const { internalStep: regularStep, nodeConfig } = normalizeRegularStep(s as Record<string, unknown>, {}, i);
		// Inline inputs on the step itself so nested-flow execution finds them.
		// (RunnerSteps recursively executes flow nodes' inner steps.)
		if (nodeConfig?.inputs) {
			(regularStep as Record<string, unknown>).inputs = nodeConfig.inputs;
		}
		// Also surface the nodeConfig in the bubbled-up innerNodes map so
		// BlokService.run can read inputs via `ctx.config[step.name]` when
		// the inner step actually executes.
		if (nodeConfig) innerNodes[regularStep.name] = nodeConfig;
		thenInternal.push(regularStep);
	}
	for (let i = 0; i < elseSteps.length; i++) {
		const s = elseSteps[i];
		if (!isPlainObject(s)) continue;
		if (isPlainObject((s as Record<string, unknown>).branch)) {
			const {
				internalStep: nestedStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeBranchStep(s as Record<string, unknown>, i);
			elseInternal.push(nestedStep);
			innerNodes[nestedStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		const { internalStep: regularStep, nodeConfig } = normalizeRegularStep(s as Record<string, unknown>, {}, i);
		if (nodeConfig?.inputs) {
			(regularStep as Record<string, unknown>).inputs = nodeConfig.inputs;
		}
		if (nodeConfig) innerNodes[regularStep.name] = nodeConfig;
		elseInternal.push(regularStep);
	}

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
 * blueprint-mapper resolution path resolves `$.state.<id>` /
 * `$.req.body.<key>` refs into concrete values BEFORE the
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
	};

	if (typeof step.idempotencyKey === "string" && step.idempotencyKey.length > 0) {
		internalStep.idempotencyKey = step.idempotencyKey;
	}
	if (typeof step.idempotencyKeyTTL === "number" && Number.isFinite(step.idempotencyKeyTTL)) {
		internalStep.idempotencyKeyTTL = step.idempotencyKeyTTL;
	}
	if (isPlainObject(step.retry)) {
		const r = step.retry as Record<string, unknown>;
		if (typeof r.maxAttempts === "number" && Number.isInteger(r.maxAttempts)) {
			const retry: RetryConfig = { maxAttempts: r.maxAttempts };
			if (typeof r.minTimeoutInMs === "number") retry.minTimeoutInMs = r.minTimeoutInMs;
			if (typeof r.maxTimeoutInMs === "number") retry.maxTimeoutInMs = r.maxTimeoutInMs;
			if (typeof r.factor === "number") retry.factor = r.factor;
			internalStep.retry = retry;
		}
	}
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
	const nodeConfig: InternalNodeConfig | null = inlineInputs ? { inputs: inlineInputs } : null;

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
 * `wait.for` (duration string or number) is parsed to milliseconds via
 * `parseDuration`. `wait.until` is left as-is — the runner resolves
 * $-proxy expressions against the live ctx at first-pass invocation.
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

	if (hasFor) {
		const raw = waitObj.for;
		if (typeof raw === "number") {
			waitForMs = raw;
		} else if (typeof raw === "string") {
			// parseDuration may throw on invalid grammar — let it surface.
			waitForMs = parseDuration(raw);
		} else {
			throw new Error(
				`[blok] WorkflowNormalizer: wait step "${id}" has invalid \`wait.for\` (must be number ms or duration string).`,
			);
		}
	}
	if (hasUntil) {
		const raw = waitObj.until;
		if (typeof raw !== "number" && typeof raw !== "string") {
			throw new Error(
				`[blok] WorkflowNormalizer: wait step "${id}" has invalid \`wait.until\` (must be number ms or string).`,
			);
		}
		waitUntil = raw;
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
	};
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
		if (kind === "http" && isPlainObject(cfg)) {
			const httpCfg = { ...(cfg as Record<string, unknown>) };
			if (httpCfg.method === "*") {
				httpCfg.method = "ANY";
				warnWildcardOnce(sourcePath);
			}
			out[kind] = httpCfg;
		} else {
			out[kind] = cfg;
		}
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
 * Test-only — reset the per-process wildcard warning cache.
 *
 * @internal
 */
export function _resetWildcardWarningCache(): void {
	_wildcardWarnedFiles = new Set<string>();
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
