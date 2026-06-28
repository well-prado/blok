/**
 * Static workflow DAG builder (E4).
 *
 * Walks a v2 workflow definition (the raw JSON object stored in
 * `WorkflowRegistry` and returned by `GET /__blok/workflows/:name` as
 * `definition`) and produces a flat list of nodes + edges that
 * `@xyflow/react` can render directly. Dagre lays out the result in
 * the component layer.
 *
 * Style: flowchart (BPMN-ish). Branches and switches are diamond
 * decision nodes whose arms re-converge at a synthetic merge node.
 * forEach/loop are headers with a back-edge that closes the iteration
 * cycle. tryCatch emits parallel try / catch / finally lanes joined by
 * a merge. Each step kind has a distinct `DagNodeKind` so the renderer
 * can pick the right icon + colour.
 *
 * The builder accepts `unknown` and narrows defensively — the API
 * declares `definition?: unknown`, mirroring the runner-side
 * `WorkflowRegistry` storage shape, so this module is the boundary at
 * which the live JSON gets translated into a typed graph.
 */

// === Internal narrowing helpers ===

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// === Step kind classification ===

export type WorkflowStepKind =
	| "regular"
	| "branch"
	| "subworkflow"
	| "wait"
	| "forEach"
	| "loop"
	| "switch"
	| "tryCatch";

/**
 * Detect which v2 step kind a raw step object belongs to. Mirrors the
 * runner's `V2StepSchema` discriminator — presence of a kind-specific
 * field (`branch`, `subworkflow`, `wait` object, `forEach`, `loop`,
 * `switch`, `tryCatch`) wins; otherwise it's a regular step.
 *
 * `wait` requires special handling because the field name overlaps
 * with `V2SubworkflowStep.wait: boolean`. Only an OBJECT value at
 * `wait` indicates the wait step kind.
 */
export function classifyStep(step: unknown): WorkflowStepKind {
	if (!isObject(step)) return "regular";
	if (isObject(step.branch)) return "branch";
	if (typeof step.subworkflow === "string") return "subworkflow";
	if (isObject(step.wait)) return "wait";
	if (isObject(step.forEach)) return "forEach";
	if (isObject(step.loop)) return "loop";
	if (isObject(step.switch)) return "switch";
	if (isObject(step.tryCatch)) return "tryCatch";
	return "regular";
}

// === Graph types ===

/**
 * Visual kind of a graph node. Drives the React component the
 * renderer uses + the colour scheme + the icon. `trigger` and `end`
 * are synthetic terminals; `merge` joins branch/switch/tryCatch arms.
 * `tryEnter` / `catchEnter` / `finallyEnter` are the labelled
 * boundaries of a tryCatch lane.
 */
export type DagNodeKind =
	| "trigger"
	| "regular"
	| "subworkflow"
	| "wait"
	| "branch"
	| "switch"
	| "forEach"
	| "loop"
	| "tryEnter"
	| "catchEnter"
	| "finallyEnter"
	| "merge"
	| "end";

export interface DagNodeData {
	/** Discriminator for the node renderer. */
	kind: DagNodeKind;
	/** Primary text shown on the node. */
	label: string;
	/** Optional secondary line (expression, runtime, id, etc.). */
	sublabel?: string;
	/**
	 * Optional structured metadata for hover/inspector reveal. Keeps
	 * the raw step around so the right pane can show full inputs etc.
	 */
	meta?: {
		stepId?: string;
		runtime?: string;
		nodeRef?: string;
		expression?: string;
		mode?: string;
		concurrency?: number;
		maxIterations?: number;
		wait?: boolean;
		allowList?: readonly string[];
		raw?: unknown;
	};
}

export interface DagNode {
	id: string;
	data: DagNodeData;
}

export interface DagEdge {
	id: string;
	source: string;
	target: string;
	label?: string;
	/** Solid (default), dashed (failure/conditional path), dotted (back-edge). */
	style?: "solid" | "dashed" | "dotted";
	/**
	 * True for the back-edge of forEach / loop. The renderer flips
	 * orientation + uses a curved path so it's visually clear the
	 * arrow points UP into the header.
	 */
	backEdge?: boolean;
}

export interface WorkflowDag {
	nodes: DagNode[];
	edges: DagEdge[];
}

// === Builder state ===

interface BuildCtx {
	nodes: DagNode[];
	edges: DagEdge[];
	path: string[];
	usedIds: Set<string>;
}

function newCtx(): BuildCtx {
	return { nodes: [], edges: [], path: [], usedIds: new Set() };
}

function stablePart(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function stepPathSegment(step: unknown, index: number): string {
	return isObject(step) && typeof step.id === "string" ? `id-${stablePart(step.id)}` : `at-${index}`;
}

function scopedStepKey(ctx: BuildCtx, step: Record<string, unknown>, fallback: string): string {
	const stepId = asString(step.id);
	return stablePart(stepId ?? ctx.path.join("-") ?? fallback);
}

function nextId(ctx: BuildCtx, prefix: string, key = ctx.path.join("-") || prefix): string {
	const base = `${prefix}-${stablePart(key)}`;
	if (!ctx.usedIds.has(base)) {
		ctx.usedIds.add(base);
		return base;
	}
	const fallback = `${base}-${stablePart(ctx.path.join("-"))}`;
	let id = fallback;
	let n = 2;
	while (ctx.usedIds.has(id)) {
		id = `${fallback}-${n}`;
		n += 1;
	}
	ctx.usedIds.add(id);
	return id;
}

function withPath<T>(ctx: BuildCtx, segment: string, run: () => T): T {
	ctx.path.push(segment);
	try {
		return run();
	} finally {
		ctx.path.pop();
	}
}

function pushNode(ctx: BuildCtx, id: string, data: DagNodeData): void {
	ctx.nodes.push({ id, data });
}

function pushEdge(
	ctx: BuildCtx,
	source: string,
	target: string,
	opts?: { label?: string; style?: DagEdge["style"]; backEdge?: boolean },
): void {
	const id = `${source}__${target}__${ctx.edges.length}`;
	ctx.edges.push({ id, source, target, ...opts });
}

// === Trigger summary ===

function summarizeTrigger(trigger: unknown): { label: string; sublabel?: string } {
	if (!isObject(trigger)) return { label: "Trigger" };

	// Pick the first concrete trigger kind present. v2 supports one
	// per workflow but the JSON shape allows multiple, so this is
	// deterministic by key insertion order.
	for (const [kind, raw] of Object.entries(trigger)) {
		if (!isObject(raw)) continue;
		switch (kind) {
			case "http": {
				const method = asString(raw.method) ?? "ANY";
				const path = asString(raw.path);
				return {
					label: `HTTP · ${method}`,
					sublabel: path,
				};
			}
			case "worker":
				return { label: "Worker", sublabel: asString(raw.queue) };
			case "cron":
				return { label: "Cron", sublabel: asString(raw.schedule) };
			case "webhook":
				return { label: "Webhook", sublabel: asString(raw.path) };
			case "grpc":
				return {
					label: "gRPC",
					sublabel: [asString(raw.service), asString(raw.method)].filter(Boolean).join("."),
				};
			default:
				return { label: kind };
		}
	}
	return { label: "Trigger" };
}

// === Step-kind emitters ===

interface Emitted {
	entry: string;
	exit: string;
}

function shortString(value: unknown, max = 40): string | undefined {
	const s = asString(value);
	if (s === undefined) return undefined;
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function summarizeExpression(value: unknown): string {
	const s = asString(value);
	if (s !== undefined) return s;
	if (value === undefined || value === null) return "—";
	try {
		const json = JSON.stringify(value);
		return json.length > 40 ? `${json.slice(0, 39)}…` : json;
	} catch {
		return String(value);
	}
}

function emitRegular(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const stepId = asString(step.id);
	const id = nextId(ctx, "step", stepId ?? ctx.path.join("-"));
	const use = asString(step.use);
	const runtime = asString(step.runtime) ?? asString(step.type);
	pushNode(ctx, id, {
		kind: "regular",
		label: stepId ?? use ?? "step",
		sublabel: use,
		meta: { stepId, nodeRef: use, runtime, raw: step },
	});
	return { entry: id, exit: id };
}

function emitSubworkflow(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const stepId = asString(step.id);
	const id = nextId(ctx, "subworkflow", stepId ?? ctx.path.join("-"));
	const target = asString(step.subworkflow) ?? "?";
	const wait = asBoolean(step.wait);
	const allowList = Array.isArray(step.allowList)
		? (step.allowList.filter((v): v is string => typeof v === "string") as readonly string[])
		: undefined;
	pushNode(ctx, id, {
		kind: "subworkflow",
		label: stepId ?? `↳ ${target}`,
		sublabel: `↳ ${target}${wait === false ? " (async)" : ""}`,
		meta: { stepId, expression: target, wait, allowList, raw: step },
	});
	return { entry: id, exit: id };
}

function emitWait(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const stepId = asString(step.id);
	const id = nextId(ctx, "wait", stepId ?? ctx.path.join("-"));
	const waitCfg = isObject(step.wait) ? step.wait : {};
	const forValue = waitCfg.for;
	const untilValue = waitCfg.until;
	let label = "wait";
	if (forValue !== undefined) {
		label = `wait ${summarizeExpression(forValue)}`;
	} else if (untilValue !== undefined) {
		label = `wait until ${summarizeExpression(untilValue)}`;
	}
	pushNode(ctx, id, {
		kind: "wait",
		label: stepId ?? label,
		sublabel: stepId ? label : undefined,
		meta: { stepId, raw: step },
	});
	return { entry: id, exit: id };
}

function emitBranch(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const branchCfg = isObject(step.branch) ? step.branch : {};
	const stepId = asString(step.id);
	const key = scopedStepKey(ctx, step, "branch");
	const decisionId = nextId(ctx, "branch", key);
	const mergeId = nextId(ctx, "merge", `${key}-branch`);
	const when = asString(branchCfg.when);

	pushNode(ctx, decisionId, {
		kind: "branch",
		label: stepId ?? "branch",
		sublabel: when ? `when ${shortString(when)}` : "when ?",
		meta: { stepId, expression: when, raw: step },
	});
	pushNode(ctx, mergeId, { kind: "merge", label: "" });

	const thenSteps = asArray(branchCfg.then);
	const elseSteps = asArray(branchCfg.else);

	const thenExit = withPath(ctx, "then", () => walkSequence(thenSteps, decisionId, ctx, { entryLabel: "then" }));
	pushEdge(ctx, thenExit, mergeId);

	if (elseSteps.length > 0) {
		const elseExit = withPath(ctx, "else", () =>
			walkSequence(elseSteps, decisionId, ctx, { entryLabel: "else", entryStyle: "dashed" }),
		);
		pushEdge(ctx, elseExit, mergeId, { style: "dashed" });
	} else {
		// No else arm — the falsy path skips straight to the merge.
		pushEdge(ctx, decisionId, mergeId, { label: "else", style: "dashed" });
	}

	return { entry: decisionId, exit: mergeId };
}

function emitSwitch(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const switchCfg = isObject(step.switch) ? step.switch : {};
	const stepId = asString(step.id);
	const key = scopedStepKey(ctx, step, "switch");
	const decisionId = nextId(ctx, "switch", key);
	const mergeId = nextId(ctx, "merge", `${key}-switch`);
	const onValue = switchCfg.on;

	pushNode(ctx, decisionId, {
		kind: "switch",
		label: stepId ?? "switch",
		sublabel: `on ${summarizeExpression(onValue)}`,
		meta: { stepId, expression: summarizeExpression(onValue), raw: step },
	});
	pushNode(ctx, mergeId, { kind: "merge", label: "" });

	const cases = asArray(switchCfg.cases);
	for (const [index, c] of cases.entries()) {
		if (!isObject(c)) continue;
		const caseLabel = `when ${summarizeExpression(c.when)}`;
		const caseExit = withPath(ctx, `case-${index}`, () =>
			walkSequence(asArray(c.do), decisionId, ctx, { entryLabel: caseLabel }),
		);
		pushEdge(ctx, caseExit, mergeId);
	}

	const defaultSteps = asArray(switchCfg.default);
	if (defaultSteps.length > 0) {
		const defaultExit = withPath(ctx, "default", () =>
			walkSequence(defaultSteps, decisionId, ctx, {
				entryLabel: "default",
				entryStyle: "dashed",
			}),
		);
		pushEdge(ctx, defaultExit, mergeId, { style: "dashed" });
	} else if (cases.length > 0) {
		// No default arm — unmatched values skip the switch entirely.
		pushEdge(ctx, decisionId, mergeId, { label: "default", style: "dashed" });
	} else {
		// Pathological: empty switch. Connect decision straight to merge.
		pushEdge(ctx, decisionId, mergeId);
	}

	return { entry: decisionId, exit: mergeId };
}

function emitForEach(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const cfg = isObject(step.forEach) ? step.forEach : {};
	const stepId = asString(step.id);
	const headerId = nextId(ctx, "forEach", stepId ?? ctx.path.join("-"));
	const asVar = asString(cfg.as);
	const inExpr = summarizeExpression(cfg.in);
	const mode = asString(cfg.mode);
	const concurrency = asNumber(cfg.concurrency);

	pushNode(ctx, headerId, {
		kind: "forEach",
		label: stepId ?? "forEach",
		sublabel: asVar ? `for each ${asVar} in ${inExpr}` : `for each in ${inExpr}`,
		meta: {
			stepId,
			expression: inExpr,
			mode,
			concurrency,
			raw: step,
		},
	});

	const body = asArray(cfg.do);
	if (body.length > 0) {
		const bodyExit = withPath(ctx, "do", () => walkSequence(body, headerId, ctx, { entryLabel: "do" }));
		pushEdge(ctx, bodyExit, headerId, { style: "dotted", backEdge: true, label: "next" });
	}
	// Exit edge to next sibling leaves the header itself.
	return { entry: headerId, exit: headerId };
}

function emitLoop(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const cfg = isObject(step.loop) ? step.loop : {};
	const stepId = asString(step.id);
	const headerId = nextId(ctx, "loop", stepId ?? ctx.path.join("-"));
	const whileExpr = asString(cfg.while) ?? summarizeExpression(cfg.while);
	const maxIterations = asNumber(cfg.maxIterations);

	pushNode(ctx, headerId, {
		kind: "loop",
		label: stepId ?? "loop",
		sublabel: `while ${shortString(whileExpr)}`,
		meta: { stepId, expression: whileExpr, maxIterations, raw: step },
	});

	const body = asArray(cfg.do);
	if (body.length > 0) {
		const bodyExit = withPath(ctx, "do", () => walkSequence(body, headerId, ctx, { entryLabel: "do" }));
		pushEdge(ctx, bodyExit, headerId, { style: "dotted", backEdge: true, label: "loop" });
	}
	return { entry: headerId, exit: headerId };
}

function emitTryCatch(step: Record<string, unknown>, ctx: BuildCtx): Emitted {
	const cfg = isObject(step.tryCatch) ? step.tryCatch : {};
	const stepId = asString(step.id);
	const key = scopedStepKey(ctx, step, "tryCatch");
	const tryEnterId = nextId(ctx, "tryEnter", key);
	const catchEnterId = nextId(ctx, "catchEnter", key);
	const mergeId = nextId(ctx, "merge", `${key}-tryCatch`);

	pushNode(ctx, tryEnterId, { kind: "tryEnter", label: stepId ?? "try", meta: { stepId, raw: step } });
	pushNode(ctx, catchEnterId, {
		kind: "catchEnter",
		label: "catch",
		sublabel: "on error",
	});
	pushNode(ctx, mergeId, { kind: "merge", label: "" });

	// try-body: try-enter → … → merge
	const trySteps = asArray(cfg.try);
	const tryExit =
		trySteps.length > 0 ? withPath(ctx, "try", () => walkSequence(trySteps, tryEnterId, ctx)) : tryEnterId;
	pushEdge(ctx, tryExit, mergeId);

	// catch-body: dashed from try-enter (any step in try can throw)
	pushEdge(ctx, tryEnterId, catchEnterId, { style: "dashed", label: "throws" });
	const catchSteps = asArray(cfg.catch);
	const catchExit =
		catchSteps.length > 0 ? withPath(ctx, "catch", () => walkSequence(catchSteps, catchEnterId, ctx)) : catchEnterId;
	pushEdge(ctx, catchExit, mergeId, { style: "dashed" });

	const finallySteps = asArray(cfg.finally);
	if (finallySteps.length > 0) {
		const finallyEnterId = nextId(ctx, "finallyEnter", key);
		pushNode(ctx, finallyEnterId, { kind: "finallyEnter", label: "finally" });
		pushEdge(ctx, mergeId, finallyEnterId);
		const finallyExit = withPath(ctx, "finally", () => walkSequence(finallySteps, finallyEnterId, ctx));
		return { entry: tryEnterId, exit: finallyExit };
	}

	return { entry: tryEnterId, exit: mergeId };
}

function emit(step: unknown, ctx: BuildCtx): Emitted {
	if (!isObject(step)) {
		// Defensive fallback — render a placeholder so malformed input
		// doesn't drop the whole graph silently.
		const id = nextId(ctx, "unknown");
		pushNode(ctx, id, { kind: "regular", label: "(invalid step)" });
		return { entry: id, exit: id };
	}
	const kind = classifyStep(step);
	switch (kind) {
		case "branch":
			return emitBranch(step, ctx);
		case "subworkflow":
			return emitSubworkflow(step, ctx);
		case "wait":
			return emitWait(step, ctx);
		case "forEach":
			return emitForEach(step, ctx);
		case "loop":
			return emitLoop(step, ctx);
		case "switch":
			return emitSwitch(step, ctx);
		case "tryCatch":
			return emitTryCatch(step, ctx);
		default:
			return emitRegular(step, ctx);
	}
}

interface WalkOptions {
	/** Label applied to the FIRST inbound edge of this sequence. */
	entryLabel?: string;
	/** Style applied to the FIRST inbound edge of this sequence. */
	entryStyle?: DagEdge["style"];
}

/**
 * Walk a sequence of steps from `prevId`. Each step's entry receives
 * an edge from the running `prev`; `prev` advances to the step's exit.
 * Returns the final exit id (caller wires this onto whatever follows).
 * If the sequence is empty, returns `prevId` so the caller can wire
 * its synthetic merge directly to the parent.
 */
function walkSequence(steps: readonly unknown[], prevId: string, ctx: BuildCtx, opts?: WalkOptions): string {
	let prev = prevId;
	let first = true;
	for (const [index, step] of steps.entries()) {
		const { entry, exit } = withPath(ctx, stepPathSegment(step, index), () => emit(step, ctx));
		if (first && opts) {
			pushEdge(ctx, prev, entry, { label: opts.entryLabel, style: opts.entryStyle });
		} else {
			pushEdge(ctx, prev, entry);
		}
		first = false;
		prev = exit;
	}
	if (first && opts) {
		// Empty sequence — still draw the labelled stub edge from
		// parent → caller's exit. The caller is responsible for the
		// merge; we just propagate `prevId` unchanged.
	}
	return prev;
}

// === Public entry point ===

/**
 * Build a flowchart-style DAG from a workflow definition. The output
 * is unstyled / unpositioned — the caller runs dagre over it to lay
 * it out and assigns visual properties at render time.
 *
 * The function NEVER throws on malformed input. Unknown step shapes
 * fall through to `emitRegular`; non-object steps emit a placeholder
 * node. This matches the "no half-failed UI" rule — operators always
 * see something they can compare to the JSON tab.
 */
export function buildWorkflowDag(definition: unknown): WorkflowDag {
	const ctx = newCtx();
	const def = isObject(definition) ? definition : {};

	const triggerId = nextId(ctx, "trigger", "workflow");
	const triggerSummary = summarizeTrigger(def.trigger);
	pushNode(ctx, triggerId, {
		kind: "trigger",
		label: triggerSummary.label,
		sublabel: triggerSummary.sublabel,
		meta: { raw: def.trigger },
	});

	const topLevelSteps = asArray(def.steps);
	const lastExit = walkSequence(topLevelSteps, triggerId, ctx);

	const endId = nextId(ctx, "end", "workflow");
	pushNode(ctx, endId, { kind: "end", label: "End" });
	pushEdge(ctx, lastExit, endId);

	return { nodes: ctx.nodes, edges: ctx.edges };
}
