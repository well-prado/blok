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
 *   steps: [{ name, node, type, active?, stop?, set_var? }],
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
 *   steps: [{ name, node, type, active, stop, set_var, as, spread, ephemeral, ... }],
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
	set_var?: boolean;
	as?: string;
	spread?: boolean;
	ephemeral?: boolean;
	stream_logs?: boolean;
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
	const name = typeof wf.name === "string" ? wf.name : "";
	const version = typeof wf.version === "string" ? wf.version : "1.0.0";
	const description = typeof wf.description === "string" ? wf.description : undefined;

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

	// Persistence knobs — v2 first, legacy `set_var` mapped second.
	const ephemeralExplicit = step.ephemeral === true;
	const ephemeralFromLegacy = step.set_var === false;
	const ephemeral = ephemeralExplicit || ephemeralFromLegacy;
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
		set_var: typeof step.set_var === "boolean" ? step.set_var : undefined,
		as,
		spread,
		ephemeral,
	};
	if (typeof step.stream_logs === "boolean") internalStep.stream_logs = step.stream_logs;
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
				internalStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeBranchStep(s as Record<string, unknown>, i);
			thenInternal.push(internalStep);
			innerNodes[internalStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		const { internalStep, nodeConfig } = normalizeRegularStep(s as Record<string, unknown>, {}, i);
		// Inline inputs on the step itself so nested-flow execution finds them.
		// (RunnerSteps recursively executes flow nodes' inner steps.)
		if (nodeConfig?.inputs) {
			(internalStep as Record<string, unknown>).inputs = nodeConfig.inputs;
		}
		// Also surface the nodeConfig in the bubbled-up innerNodes map so
		// BlokService.run can read inputs via `ctx.config[step.name]` when
		// the inner step actually executes.
		if (nodeConfig) innerNodes[internalStep.name] = nodeConfig;
		thenInternal.push(internalStep);
	}
	for (let i = 0; i < elseSteps.length; i++) {
		const s = elseSteps[i];
		if (!isPlainObject(s)) continue;
		if (isPlainObject((s as Record<string, unknown>).branch)) {
			const {
				internalStep,
				nodeConfig: nestedConfig,
				innerNodes: nestedInner,
			} = normalizeBranchStep(s as Record<string, unknown>, i);
			elseInternal.push(internalStep);
			innerNodes[internalStep.name] = nestedConfig;
			Object.assign(innerNodes, nestedInner);
			continue;
		}
		const { internalStep, nodeConfig } = normalizeRegularStep(s as Record<string, unknown>, {}, i);
		if (nodeConfig?.inputs) {
			(internalStep as Record<string, unknown>).inputs = nodeConfig.inputs;
		}
		if (nodeConfig) innerNodes[internalStep.name] = nodeConfig;
		elseInternal.push(internalStep);
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
