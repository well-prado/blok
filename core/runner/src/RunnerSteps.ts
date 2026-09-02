import { parseDuration } from "@blokjs/helper";
import {
	type Context,
	EnforcementViolationError,
	GlobalError,
	type NodeBase,
	type Step,
	isNonRetryableError,
	isNonRetryableStepError,
	mapper,
	markNonRetryableStepError,
} from "@blokjs/shared";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type BlokResponse from "./BlokResponse";
import { RunCancelledError } from "./RunCancelledError";
import { WaitDispatchRequest } from "./WaitDispatchRequest";
import { enforceStepOutput } from "./enforcement/AgentEnforcement";
import {
	EnforcementBypassError,
	consumeEnforcementOverride,
	getEnforcementBinding,
} from "./enforcement/EnforcementProfile";
import { resolveIdempotencyKey } from "./idempotency/resolveIdempotencyKey";
import {
	PolicyAuditError,
	PolicyDeniedError,
	PolicyInteractionRequiredError,
	type PolicyToken,
	authorizeStep,
	hasPolicyExecution,
	recordPostExecution,
} from "./policy/PolicyPipeline";
import { getPrimitiveStack } from "./runtime/PrimitiveStack";
import { StepTimeoutError } from "./timeouts/StepTimeoutError";
import { RunTracker } from "./tracing/RunTracker";
import { sanitize } from "./tracing/sanitize";
import { applyStepOutput } from "./workflow/PersistenceHelper";

export type BeforeStepHook = (
	ctx: Context,
	step: NodeBase,
	index: number,
	total: number,
	deep: boolean,
) => void | Promise<void>;

/**
 * Default TTL for idempotency cache entries when the step author does not
 * pass `idempotencyKeyTTL` explicitly. 24 hours, matching Trigger.dev's
 * default and the decision recorded in the Tier 1 ROADMAP session.
 */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * OBS-02 B4 — module-level tracer for per-step child spans. Returns a no-op
 * tracer (zero overhead) until a real TracerProvider is registered at trigger
 * boot, so free-running deployments are unaffected.
 */
const stepTracer = trace.getTracer("@blokjs/runner.steps", "1.0.0");

/**
 * Compute the delay before retry attempt N+1 using capped exponential
 * backoff. Mirrors Trigger.dev's `retry` semantics — no jitter by default.
 *
 * `delay = min(maxTimeoutInMs, minTimeoutInMs * factor^(attempt - 1))`
 *
 * Defaults: min=1000, max=30000, factor=2 — same as Trigger.dev.
 */
function computeBackoff(
	config: { minTimeoutInMs?: number; maxTimeoutInMs?: number; factor?: number },
	attempt: number,
): number {
	const min = config.minTimeoutInMs ?? 1000;
	const max = config.maxTimeoutInMs ?? 30000;
	const factor = config.factor ?? 2;
	const raw = min * factor ** Math.max(0, attempt - 1);
	return Math.min(max, Math.floor(raw));
}

/**
 * #704 — resolve a `wait.for` / `wait.until` expression against the live ctx,
 * at the moment the wait step executes.
 *
 * The wire string is whatever `normalizeWaitStep` carried through: a lowered
 * structural `{$ref}` or a hand-written `js/…` escape hatch. Resolution is the
 * same {@link mapper} the step-inputs path uses, so `BLOK_MAPPER_MODE` and the
 * expression grammar are identical here — no second dialect.
 *
 * Both failure routes end at ONE error naming the step and the field:
 * `strict` mode throws `MapperResolutionError`, while `warn` / `silent` hand
 * back the literal expression string. Passing that string on to the duration
 * parser would report a confusing "invalid duration" for what is really an
 * unresolvable reference.
 */
function resolveWaitExpression(expr: string, ctx: Context, stepName: string, field: string): unknown {
	let value: unknown;
	try {
		value = mapper.replaceString(expr, ctx, {});
	} catch (cause) {
		throw new Error(
			`${field} on step "${stepName}": cannot resolve \`${expr}\` against the current context — ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
	if (value === expr) {
		throw new Error(
			`${field} on step "${stepName}": \`${expr}\` did not resolve against the current context. Check that the producing step ran and wrote the value before this wait.`,
		);
	}
	return value;
}

/** Parse a resolved `wait.for` value into milliseconds, or say why it can't be. */
function parseWaitDuration(value: unknown, stepName: string, expr: string): number {
	if (typeof value === "number" || typeof value === "string") {
		try {
			return parseDuration(value);
		} catch (cause) {
			throw new Error(
				`wait.for on step "${stepName}": \`${expr}\` resolved to ${JSON.stringify(value)}, which is not a duration — ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}
	}
	throw new Error(
		`wait.for on step "${stepName}": \`${expr}\` resolved to ${JSON.stringify(value) ?? typeof value}, expected a millisecond number or a duration string like "30s".`,
	);
}

/**
 * Parse a `wait.until` value into an absolute ms-since-epoch deadline.
 * ms-since-epoch (number or numeric string) first, then `Date.parse`.
 */
function parseWaitTimestamp(value: unknown, stepName: string, expr?: string): number {
	if (typeof value === "number" && !Number.isNaN(value)) return value;
	if (typeof value === "string") {
		const asNum = Number(value);
		if (!Number.isNaN(asNum)) return asNum;
		const t = Date.parse(value);
		if (!Number.isNaN(t)) return t;
	}
	// Fail-fast on unparseable values (the helpful path).
	const origin = expr === undefined ? "" : ` (\`${expr}\` on step "${stepName}")`;
	throw new Error(
		`wait.until: cannot parse ${JSON.stringify(value) ?? String(value)} as a number or date${origin}. Use ms-since-epoch (number or numeric string) or a valid ISO date string.`,
	);
}

/**
 * Default cap on the JSON-serialized `ctx.state` snapshot taken before
 * a `WaitDispatchRequest` throw. 1 MB matches the existing
 * `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` cap used by the durable scheduler
 * for trigger payloads. Override per-deployment via the env var of the
 * same name.
 */
const DEFAULT_STATE_SNAPSHOT_MAX_BYTES = 1_048_576;

/**
 * Serialize `ctx.state` for persistence in `workflow_runs.state_snapshot`
 * (sqlite migration v11). Called immediately before the runner throws
 * `WaitDispatchRequest`, so the snapshot reflects the canonical pre-wait
 * state. Honors two ops env vars:
 *
 *  - `BLOK_STATE_SNAPSHOT_DISABLED=1` — kill-switch. Returns `undefined`
 *    and the runner does NOT update the column. The wait still defers;
 *    cross-process recovery just resumes with empty `ctx.state`. Use
 *    this when state contains values that JSON.stringify can't round-
 *    trip safely (Date, Map, BigInt, circular refs) and the author
 *    accepts the limitation.
 *  - `BLOK_STATE_SNAPSHOT_MAX_BYTES=<n>` — cap on the serialized blob
 *    (default 1 MB). Above the cap, the helper logs a warning and
 *    returns `undefined`. Same effect as the kill-switch for that one
 *    run; subsequent runs with smaller state still snapshot.
 *
 * On JSON serialization failure (typed errors that bubble out of
 * `JSON.stringify` — circular refs, BigInt, etc.), the helper logs a
 * warning and returns `undefined`. The wait still defers — resumption
 * for that specific run becomes best-effort, matching pre-v0.6
 * behaviour for top-level waits across process restart.
 */
export function serializeStateSnapshot(
	state: unknown,
	logger: { logLevel: (level: string, message: string) => void },
): string | undefined {
	if (process.env.BLOK_STATE_SNAPSHOT_DISABLED === "1") return undefined;
	const capRaw = process.env.BLOK_STATE_SNAPSHOT_MAX_BYTES;
	const cap = capRaw ? Number(capRaw) : DEFAULT_STATE_SNAPSHOT_MAX_BYTES;
	const effectiveCap = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_STATE_SNAPSHOT_MAX_BYTES;
	let serialized: string;
	try {
		serialized = JSON.stringify(state ?? {});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.logLevel(
			"warn",
			`[blok][wait] ctx.state snapshot failed to serialize: ${msg}. Wait will still defer; resumption is best-effort across process restart.`,
		);
		return undefined;
	}
	const size = Buffer.byteLength(serialized, "utf8");
	if (size > effectiveCap) {
		logger.logLevel(
			"warn",
			`[blok][wait] ctx.state snapshot exceeds ${effectiveCap} bytes (got ${size}); skipping snapshot. Wait will still defer; resumption is best-effort. Reduce state size or raise BLOK_STATE_SNAPSHOT_MAX_BYTES.`,
		);
		return undefined;
	}
	return serialized;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isRequiredTransition(step: NodeBase): boolean {
	return (
		step.agentStep !== undefined ||
		step.approval !== undefined ||
		step.assertionGate !== undefined ||
		step.evidenceGate !== undefined
	);
}

function deviationReason(step: NodeBase): string {
	if (step.agentStep) return "agent-step-skipped";
	if (step.approval) return "approval-skipped";
	if (step.assertionGate) return "assertion-gate-skipped";
	return "evidence-gate-skipped";
}

/**
 * Unwrap a step result to the bare value that `applyStepOutput` persists to
 * `state[<id>]`.
 *
 * A step leaves EITHER a raw value (a hand-rolled `RunnerNode` / runtime
 * adapter, whose `model.data` is already the bare payload) OR a `BlokResponse`
 * envelope (`{ data, contentType, success, error, steps }` — the `defineNode`
 * / module-node shape, where `Blok.run` sets `response.data = <envelope>`). On
 * the FRESH path each node calls `applyStepOutput(ctx, this, result)` with the
 * UNWRAPPED `.data`, so the state slot holds the bare value. The idempotency
 * cache, however, stores `model.data` — which for a `defineNode` step is the
 * whole envelope. Replaying the envelope straight into `applyStepOutput` on a
 * cache HIT would persist a `BlokResponse` object at `state[<id>]` (and merge
 * `{data, steps, success, …}` into state under `spread`) — a shape mismatch
 * versus the fresh run it's supposed to be equivalent to.
 *
 * Unwrapping here restores the invariant: a cache HIT persists the SAME bare
 * value a fresh run did. Uses the codebase's established envelope discriminator
 * (`"data" in x && "contentType" in x`, the same `hasWrapper` check the HTTP
 * `responseEmitter` and `ForEachNode.unwrapIterationResult` use). `ctx.response`
 * is still restored to the raw cached value (envelope included) so the trigger's
 * final-response resolution matches a fresh run too.
 */
function unwrapPersistedData(cached: unknown): unknown {
	return cached !== null &&
		typeof cached === "object" &&
		!Array.isArray(cached) &&
		"data" in cached &&
		"contentType" in cached
		? (cached as { data: unknown }).data
		: cached;
}

function stepOutput(modelData: unknown): unknown {
	if (modelData === null || typeof modelData !== "object" || Array.isArray(modelData)) return modelData;
	const candidate = modelData as Record<string, unknown>;
	return typeof candidate.success === "boolean" && "data" in candidate && "error" in candidate
		? candidate.data
		: modelData;
}

/**
 * Tier 2 quick-wins — wrap a Promise in a setTimeout-based timeout
 * race. On timeout, rejects with `StepTimeoutError`. The underlying
 * `fn()` continues to run (no AbortSignal cancellation in v1) but
 * the runner has already moved on — orphaned resolution settles
 * harmlessly into the void.
 */
function wrapWithTimeout<T>(fn: () => Promise<T>, ms: number, stepName: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new StepTimeoutError(stepName, ms));
		}, ms);
		fn().then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export default abstract class RunnerSteps {
	/**
	 * Debugger seam at the real execution boundary. Normal contexts have no hook,
	 * so the production path remains a single optional-property check.
	 */
	protected beforeStep(
		ctx: Context,
		step: NodeBase,
		index: number,
		total: number,
		deep: boolean,
	): void | Promise<void> {
		return (ctx as Context & { _blokBeforeStep?: BeforeStepHook })._blokBeforeStep?.(ctx, step, index, total, deep);
	}

	/**
	 * Executes a series of steps in the given context.
	 *
	 * @param ctx - The context in which the steps are executed.
	 * @param steps - An array of BlokService steps to be executed.
	 * @param deep - A boolean indicating whether the function is being called recursively for flow steps.
	 * @param step_name - The name of the current step being processed in a flow.
	 * @returns A promise that resolves to the updated context after all steps have been executed.
	 * @throws {GlobalError} Throws a GlobalError if any step results in an error.
	 */
	async runSteps(ctx: Context, steps: NodeBase[], deep = false, step_name = ""): Promise<Context> {
		ctx.config = { ...ctx.config };

		const traceRunId = (ctx as Record<string, unknown>)._traceRunId as string | undefined;
		const tracker = traceRunId ? RunTracker.getInstance() : null;
		const depthLevel = deep ? 1 : 0;

		try {
			ctx.logger.log(`Starting runner for ${steps.length} steps ${!deep ? "(Parent)" : `(${step_name})`}`);
			let flow = false;
			let flow_steps: NodeBase[] = [];
			let flow_step = 0;
			let stepName = "";

			const { resumeFromIndex, persistedRun, innerResumeIndex } = this.resolveResumeCursor(
				ctx,
				deep,
				tracker,
				traceRunId,
			);
			const binding = getEnforcementBinding(ctx);
			if (binding && binding.profile !== "advisory" && !hasPolicyExecution(ctx)) {
				throw new EnforcementBypassError(
					`${binding.profile} enforcement requires an installed agent policy context before execution`,
				);
			}

			for (let i = 0; i < steps.length; i++) {
				const step: NodeBase = steps[i];
				const binding = getEnforcementBinding(ctx);

				// PR 4 — skip pre-wait steps on resume. State + NodeRuns
				// from the first pass are still on `ctx.state` / in the
				// store; the runner just advances past them.
				if (i < resumeFromIndex) {
					ctx.logger.log(
						`[step ${i + 1}/${steps.length}] ${step.name} → skipped (resumed past wait at lastCompletedStepIndex=${persistedRun?.lastCompletedStepIndex})`,
					);
					continue;
				}

				// Tier 2 follow-up · cooperative cancellation. Operators can
				// abort `running` runs via `POST /__blok/runs/:runId/cancel`,
				// which fires the ctx's AbortController. The check is between
				// steps so a long-running step's `step.process()` doesn't have
				// to consult the signal itself (though nodes that want finer
				// granularity can read `ctx.signal.aborted` themselves).
				if (ctx.signal?.aborted) {
					throw new RunCancelledError(traceRunId);
				}

				// v0.6 Phase 4 — bump the TOP primitive frame's
				// `innerStepIndex` to the current step. If a wait fires from
				// inside this step (or anywhere deeper down the call stack),
				// the wait-throw site walks the stack to persist each frame
				// and needs the TOP frame's cursor to point at THIS step.
				// `deep === true` is the only case where this can apply —
				// the top-level runSteps doesn't have a frame.
				if (deep) {
					const stack = getPrimitiveStack(ctx);
					if (stack.length > 0) {
						stack[stack.length - 1].cursor.innerStepIndex = i;
					}
				}

				if (!step.active) {
					if (binding && isRequiredTransition(step)) {
						const override = consumeEnforcementOverride(ctx, step.name);
						if (binding.profile === "strict") {
							throw new EnforcementBypassError(
								`strict enforcement rejected skipped required transition "${step.name}"`,
							);
						}
						if (binding.profile === "guided" && !override) {
							throw new EnforcementBypassError(
								`guided enforcement requires an authorized override for skipped transition "${step.name}"`,
							);
						}
						if (override && tracker && traceRunId) tracker.recordEnforcementOverride(traceRunId, override);
						if (tracker && traceRunId) {
							tracker.recordEnforcementDeviation(traceRunId, {
								stepId: step.name,
								index: i,
								reasonCode: deviationReason(step),
								message: `required transition "${step.name}" was skipped`,
								recordedAt: new Date().toISOString(),
							});
						}
					}
					// Track skipped nodes
					if (tracker && traceRunId) {
						tracker.skipNode(traceRunId, step.name, i, "inactive");
					}
					continue;
				}
				if (step.stop) {
					const remainingRequired = steps.slice(i).find(isRequiredTransition);
					if (binding && remainingRequired) {
						if (binding.profile === "strict") {
							throw new EnforcementBypassError(
								`strict enforcement rejected stop before required transition "${remainingRequired.name}"`,
							);
						}
						if (binding.profile === "guided") {
							const override = consumeEnforcementOverride(ctx, remainingRequired.name);
							if (!override) {
								throw new EnforcementBypassError(
									`guided enforcement requires an authorized override before stopping at "${step.name}"`,
								);
							}
							if (tracker && traceRunId) tracker.recordEnforcementOverride(traceRunId, override);
						}
						if (tracker && traceRunId) {
							tracker.recordEnforcementDeviation(traceRunId, {
								stepId: remainingRequired.name,
								index: i,
								reasonCode: "required-transition-not-reached",
								message: `runner stopped before required transition "${remainingRequired.name}"`,
								recordedAt: new Date().toISOString(),
							});
						}
					}
					break;
				}

				const pause = this.beforeStep(ctx, step, i, steps.length, deep);
				if (pause) await pause;
				// Cancellation may have arrived while a debugger held the step.
				if (ctx.signal?.aborted) {
					throw new RunCancelledError(traceRunId);
				}

				// Stamp the step's declared content-type onto the rolling
				// response, but ONLY when `ctx.response` is a `BlokResponse`
				// envelope — i.e. it already carries its own `contentType` key.
				// Between steps `ctx.response` holds the PREVIOUS step's raw
				// `.data` (see `ctx.response = model.data` below). For runtime
				// (and other raw `RunnerNode`) steps that is the node's return
				// value VERBATIM and, crucially, the SAME object reference held
				// in `ctx.state[<id>]`. Writing `contentType` onto it would (a)
				// leak a spurious `contentType` key into the response body and
				// `ctx.state.<id>`, and (b) throw on a primitive / frozen return.
				// The `"contentType" in` guard limits stamping to the wrapper
				// shape, leaving raw payloads — and the state they're shared
				// with — untouched. (Regression: Bug 4 + the `runtime.*`
				// content-type leak.)
				if (ctx.response && typeof ctx.response === "object" && "contentType" in ctx.response) {
					try {
						(ctx.response as { contentType?: string }).contentType = step.contentType;
					} catch {
						// Non-extensible / sealed / readonly `contentType` —
						// nothing downstream depends on stamping it here.
					}
				}

				if (!step.flow) {
					// Prepare resolves the input slice and completes local schema
					// validation before the policy boundary. The existing process()
					// implementation is then reused for the actual effect.
					try {
						await step.prepare(ctx);
					} catch (error) {
						if (error && typeof error === "object") (error as { _blokStepId?: string })._blokStepId = step.name;
						throw error;
					}
					// --- Trace: start node ---
					let nodeRunId: string | undefined;
					const stepAny = step as unknown as Record<string, unknown>;
					const stepType = (stepAny.type as string) || "unknown";
					// Runtime nodes (RuntimeAdapterNode) expose `transport` so
					// operators can tell at a glance whether the step ran via
					// HTTP, gRPC, or in-process module nodes. Module/local
					// nodes don't carry the field — prefix stays one-tag.
					const transport = stepAny.transport as string | undefined;
					const stepPrefix = transport
						? `[step ${i + 1}/${steps.length}] ${step.name} (${stepType}, ${transport})`
						: `[step ${i + 1}/${steps.length}] ${step.name} (${stepType})`;

					// --- Step metadata for runtime adapters ---
					// Populate `ctx._stepInfo` so adapters (e.g. GrpcRuntimeAdapter)
					// can report the step's position in the workflow without each
					// adapter having to plumb its own counter. Set unconditionally —
					// independent of whether tracing is enabled.
					(ctx as Record<string, unknown>)._stepInfo = {
						name: step.name,
						index: i,
						total: steps.length,
						depth: depthLevel,
					};

					// Reset the response content-type side-channel before the
					// step runs. A runtime adapter step repopulates it from the
					// SDK's proto `content_type` (see RuntimeAdapterNode.run);
					// module / raw steps leave it cleared so the trigger falls
					// back to the default. Clearing per-step means the value
					// surviving to the trigger reflects ONLY the final step,
					// never a stale content-type from an earlier runtime step.
					(ctx as Record<string, unknown>)._stepContentType = undefined;

					if (tracker && traceRunId) {
						const configAny = ctx.config as unknown as Record<string, Record<string, unknown>>;
						// Tier 2 #4 sub-workflow: capture the `wait` mode so
						// Studio can render `↳ async` (wait:false) vs `↳ sub`
						// (wait:true / default) in StepRail. Only meaningful
						// for subworkflow steps; undefined elsewhere.
						const subworkflowWait = stepType === "subworkflow" ? (stepAny.wait as boolean | undefined) : undefined;
						// G2 (v0.6) — capture the `dispatch` strategy so the
						// rail can mark http-self invocations with a small
						// `http` badge alongside the existing `↳ async`/`↳ sub`.
						// Normalize: unknown values + the default fall through
						// to `undefined` (rendered as in-process by Studio).
						const dispatchRaw = stepType === "subworkflow" ? (stepAny.dispatch as unknown) : undefined;
						const subworkflowDispatch: "in-process" | "http-self" | undefined =
							dispatchRaw === "http-self" || dispatchRaw === "in-process" ? dispatchRaw : undefined;
						// PR 5 E3 — surface sub-workflow nesting depth.
						// `_subworkflowDepth` on ctx is set by SubworkflowNode +
						// createChildContext; the parent's invocation of a
						// child step has depth = parent.depth + 1. Top-level =
						// 1; nested = 2+. Only meaningful for subworkflow steps.
						const subworkflowDepth =
							stepType === "subworkflow"
								? (((ctx as Record<string, unknown>)._subworkflowDepth as number | undefined) ?? 0) + 1
								: undefined;
						// v0.5 middleware origin tagging — when the trigger's
						// `runMiddlewareChain` is dispatching a middleware
						// workflow on this ctx, it sets `_blokMiddlewareName`
						// to the middleware's name. Surface that here so
						// Studio's StepRail can render a `mw:<name>` origin
						// badge on every inner step the middleware produced.
						const middleware = (ctx as Record<string, unknown>)._blokMiddlewareName as string | undefined;
						// v0.5.3 — read the iteration sentinel set by ForEachNode +
						// LoopNode on per-iteration child ctxs. Lets Studio group
						// inner steps under "iteration N" headers in StepRail.
						// Inherited by nested runners (tryCatch, switch) inside
						// the same iteration — which is correct: their inner steps
						// belong to that iteration. A nested forEach inside an
						// outer iteration overrides the sentinel on its own child
						// ctx, so the inner-most iteration wins for its descendants.
						const iterationIndexRaw = (ctx as Record<string, unknown>)._blokIterationIndex;
						const iterationIndex = typeof iterationIndexRaw === "number" ? iterationIndexRaw : undefined;
						const nodeRun = tracker.startNode(traceRunId, {
							nodeName: step.name,
							nodeType: stepType,
							runtimeKind: stepAny.runtime as string | undefined,
							inputs: sanitize(configAny?.[step.name]?.inputs ?? stepAny.config),
							depth: depthLevel,
							stepIndex: i,
							wait: subworkflowWait,
							dispatch: subworkflowDispatch,
							subworkflowDepth,
							middleware,
							iterationIndex,
						});
						nodeRunId = nodeRun.id;
						(ctx as Record<string, unknown>)._traceNodeId = nodeRunId;
					}

					// === PR 4: wait.for(duration) / wait.until(date) step ===
					// Two paths:
					//   1. First pass: compute deadline, mark NodeRun complete
					//      (the wait step has no `process()` body), set the
					//      run's resume cursor (lastCompletedStepIndex = i - 1),
					//      throw WaitDispatchRequest. TriggerBase translates to
					//      DeferredDispatchSignal → 202 Accepted.
					//   2. Re-entry (dispatchDeferred): the resume cursor logic
					//      at the top of runSteps already skipped indices < i.
					//      For the wait step itself at i = lastCompletedStepIndex
					//      + 1, treat it as satisfied and advance.
					//      Detection: existence of run.scheduledAt + wait step =
					//      we're on the second pass.
					if (stepType === "wait") {
						const waitForMs = stepAny.waitForMs as number | undefined;
						const waitUntil = stepAny.waitUntil as number | string | undefined;
						// #704 — the resolved-at-dispatch half. Set by
						// `normalizeWaitStep` when the author wrote a handle /
						// `{$ref}` / `js/…` instead of a literal.
						const waitForExpr = stepAny.waitForExpr as string | undefined;
						const waitUntilExpr = stepAny.waitUntilExpr as string | undefined;

						// Compute the deadline (resolves ISO strings and, since
						// #704, ctx references).
						// Review fix-up · BUG-2. A malformed `until` string used to
						// silently fall through to `Date.now()` (immediate no-op).
						// Authors expecting "wait until tomorrow" with a typo got a
						// no-op with no warning — the worst kind of footgun. Throw
						// instead so the failure surfaces immediately, both in the
						// run trace + Studio's error surface.
						const computeDeadline = (): number => {
							if (waitForExpr !== undefined) {
								const resolved = resolveWaitExpression(waitForExpr, ctx, step.name, "wait.for");
								return Date.now() + parseWaitDuration(resolved, step.name, waitForExpr);
							}
							if (typeof waitForMs === "number") return Date.now() + waitForMs;
							if (waitUntilExpr !== undefined) {
								const resolved = resolveWaitExpression(waitUntilExpr, ctx, step.name, "wait.until");
								return parseWaitTimestamp(resolved, step.name, waitUntilExpr);
							}
							if (typeof waitUntil === "number") return waitUntil;
							if (typeof waitUntil === "string") return parseWaitTimestamp(waitUntil, step.name);
							// Schema rejects this combination, but defensive: treat
							// unsupported input as immediate so the runner doesn't
							// hang on a never-firing timer.
							return Date.now();
						};

						// Detect re-entry: on first pass the run has no
						// scheduledAt (or it's from trigger-level delay); on
						// re-entry from a wait dispatch, the run was marked
						// `delayed` with scheduledAt set to the wait deadline.
						//
						// v0.6 Phase 4 — for deep (nested) runSteps, a primitive
						// (SwitchNode etc.) sets `_blokInnerResumeIndex` to the
						// resume target — including `0` when the wait is at the
						// first step of its sub-pipeline. The original
						// `resumeFromIndex > 0` guard prevented re-entry from
						// firing at index 0, but Phase 4 needs the index-0 case
						// (e.g., switch arm whose first step is the wait). For
						// deep runs we additionally require `innerResumeIndex`
						// to be defined — that's how we tell "this primitive
						// resumed here" vs "we're at index 0 because of a fresh
						// iteration that doesn't have a resume cursor".
						const isReentry =
							(ctx as Record<string, unknown>)._blokDispatchReentry === true &&
							i === resumeFromIndex &&
							(!deep ? resumeFromIndex > 0 : innerResumeIndex !== undefined);

						// #704 — reload safety. On re-entry the wait is ALREADY
						// satisfied and the deadline is only trace decoration, but
						// re-resolving a ctx reference can now THROW: the state
						// snapshot is best-effort (skipped when it exceeds
						// BLOK_STATE_SNAPSHOT_MAX_BYTES or fails to serialize), so
						// after a cross-process restore the producing step's slot
						// may be gone. Killing a resumed run at a wait it already
						// served would be the worst possible failure. Literals are
						// cheap and total, so they keep computing — the recorded
						// deadline stays byte-identical to pre-#704.
						const deadline = isReentry && (waitForExpr ?? waitUntilExpr) !== undefined ? Date.now() : computeDeadline();
						const now = Date.now();

						if (isReentry || deadline <= now) {
							// Wait already satisfied (timer fired AND we're on
							// re-entry past the deadline) OR the deadline is
							// in the past (e.g., wait.for(0) or wait.until(<past>)).
							// Mark NodeRun complete and advance.
							if (tracker && nodeRunId) {
								tracker.completeNode(nodeRunId, { __waited__: true, deadline });
							}
							ctx.logger.log(`[step ${i + 1}/${steps.length}] ${step.name} (wait) → satisfied`);
							// Advance the resume cursor at TOP-LEVEL only.
							// Nested satisfies (deep=true, v0.6 Phase 2 — wait
							// inside a forEach iteration body) must NOT
							// overwrite the workflow's resume cursor with the
							// inner step index — that would skip past the
							// primitive entirely on the next re-entry. The
							// primitive's own NodeRun.iteration_context tracks
							// progress for nested resumes.
							if (!deep && tracker && traceRunId) {
								tracker.getStore().updateRun(traceRunId, { lastCompletedStepIndex: i });
							}
							continue;
						}

						// First pass: schedule + throw WaitDispatchRequest.
						// Set resume cursor BEFORE throwing so re-entry knows
						// where to pick up.
						//
						// Two cases for cursor placement:
						//   - Top-level wait (deep === false). Cursor = i - 1
						//     (the last non-wait outer step that completed).
						//     On re-entry, runSteps reads
						//     workflow_runs.lastCompletedStepIndex + 1 = i and
						//     starts the wait step which flips to "satisfied".
						//   - Nested wait inside a primitive (deep === true,
						//     v0.6 Phase 2). The wait fired from inside an
						//     iteration body of a forEach (or analogous future
						//     primitive). The OUTER runSteps wrote `i - 1` =
						//     forEach-step-index minus 1 *before* invoking
						//     forEach.process, so workflow_runs.lastCompleted-
						//     StepIndex still points at the OUTER cursor we
						//     want — DON'T overwrite it with the inner-i (that
						//     would skip the forEach entirely on resume).
						//     Instead, persist the iteration cursor on the
						//     forEach's NodeRun's `iteration_context` column.
						//     ForEachNode reads it on re-entry to resume the
						//     right iteration + inner step.
						//
						// v0.6 prerequisite for wait-inside-primitives Phase 2
						// — snapshot `ctx.state` regardless of nesting. Two
						// re-entry paths consume this snapshot:
						//   1. In-process timer fire (DeferredRunScheduler):
						//      same `ctx` is reused, state is already there;
						//      rehydrate at TriggerBase.run is a no-op.
						//   2. Cross-process recovery (recoverDispatches →
						//      restoreDispatch on boot): a fresh `ctx` is
						//      built from the persisted scheduled_dispatches
						//      row with empty `state`. Without the snapshot,
						//      Phase 2's iteration-state-persistence promise
						//      breaks across restart.
						if (tracker && traceRunId) {
							const updates: Record<string, unknown> = {
								stateSnapshot: serializeStateSnapshot(ctx.state, ctx.logger),
							};
							if (!deep) {
								updates.lastCompletedStepIndex = i - 1;
							}
							tracker.getStore().updateRun(traceRunId, updates);

							// Phase 2/3 — write iteration_context to the active
							// primitive's NodeRun when nested. Reads sentinels
							// stamped by the primitive (ForEachNode in Phase 2,
							// LoopNode in Phase 3) on the parent ctx:
							//   - _blokActivePrimitiveNodeRunId: which NodeRun
							//     gets the cursor (set by RunnerSteps' outer
							//     iteration around the primitive's process()).
							//   - _blokForEachCurrentIteration: iteration index
							//     of the in-flight iteration.
							//   - _blokForEachPartialResults (Phase 2 only):
							//     accumulator for iterations [0..iteration-1]
							//     so the post-resume final result array covers
							//     all iterations. LoopNode doesn't aggregate
							//     results (it returns the last iteration's
							//     output), so it doesn't stamp this sentinel —
							//     the cursor stores `completedResults: []` and
							//     LoopNode ignores the field on resume.
							// v0.6 Phase 4 — walk the primitive stack and persist
							// each frame's cursor to its NodeRun. The TOP frame's
							// `innerStepIndex` is the wait step's position within
							// the deepest primitive's sub-pipeline; outer frames'
							// `innerStepIndex` values were set by their enclosing
							// runSteps' step-boundary write when control passed
							// into the deeper primitive. This is what lets
							// `forEach > forEach > wait`,
							// `switch > forEach > wait`, etc. all resume
							// correctly on re-entry.
							//
							// Each frame's `cursor` is owned by the primitive
							// (it stamps `iteration`/`caseIndex`/`completedResults`).
							// The runner's only responsibility here is to refresh
							// the TOP frame's `innerStepIndex` to `i` and
							// persist every frame.
							if (deep) {
								const stack = getPrimitiveStack(ctx);
								if (stack.length > 0) {
									stack[stack.length - 1].cursor.innerStepIndex = i;
									for (const frame of stack) {
										// Skip parallel-forEach frames — the
										// parallel branch in ForEachNode writes
										// its own cursor (with cancelled set +
										// completedResults) post-`Promise.allSettled`.
										// Writing the placeholder here would let
										// "error beats wait" classifications leak
										// a parallel cursor onto the failed
										// run's NodeRun.
										if (frame.cursor.mode === "parallel") continue;
										tracker.getStore().updateNodeRun(frame.nodeRunId, {
											iterationContext: frame.cursor,
										});
									}
								}
							}
						}
						ctx.logger.log(
							`[step ${i + 1}/${steps.length}] ${step.name} (wait) → scheduled (deadline=${new Date(deadline).toISOString()})`,
						);
						throw new WaitDispatchRequest({
							scheduledAt: deadline,
							stepIndex: i,
							stepId: step.name,
							lastCompletedStepIndex: i - 1,
						});
					}

					if (step.approval && !hasPolicyExecution(ctx))
						throw new EnforcementViolationError(
							"APPROVAL_REQUIRES_AGENT_CONTEXT",
							`Step "${step.name}" declares approval but is running outside an agent policy context`,
						);

					// === Tier 1: idempotency cache lookup ===
					// Resolve the step's idempotency key against the live ctx,
					// then consult the cache. On hit, short-circuit step.process
					// entirely: replay the cached result through the same v2
					// persistence rules (ephemeral / spread / as), mark the
					// node cached for tracing, log "cached", and skip to the
					// next step. Caching layers ABOVE PersistenceHelper —
					// applyStepOutput's rules apply identically to cached and
					// freshly-computed results.
					const workflowName = (ctx as { workflow_name?: string }).workflow_name ?? "";
					const cacheStore = tracker && traceRunId ? tracker.getStore() : null;
					const resolvedIdemKey =
						cacheStore && workflowName
							? resolveIdempotencyKey((step as NodeBase).idempotencyKey, ctx, {
									field: "idempotencyKey",
									where: `step "${step.name}"`,
								})
							: null;

					if (cacheStore && resolvedIdemKey && nodeRunId) {
						const hit = cacheStore.getIdempotencyCache(workflowName, step.name, resolvedIdemKey);
						if (hit) {
							const cachePolicy = await authorizeStep(ctx, step, 1, true);
							try {
								enforceStepOutput(step, stepOutput(hit.data));
							} catch (error) {
								if (cachePolicy)
									await recordPostExecution(
										ctx,
										cachePolicy,
										"failure",
										error instanceof Error ? error.name : "EnforcementViolationError",
									);
								throw error;
							}
							// Persist the UNWRAPPED value so a cache HIT lands the
							// same bare `state[<id>]` shape a fresh run did (defineNode
							// steps cache the full BlokResponse envelope; state stores
							// its `.data`). `ctx.response` keeps the raw cached value
							// so the trigger's final-response resolution is unchanged.
							applyStepOutput(ctx, step, { data: unwrapPersistedData(hit.data) });
							ctx.response = hit.data as BlokResponse;
							tracker?.markNodeCached(
								nodeRunId,
								{
									sourceRunId: hit.sourceRunId,
									sourceNodeRunId: hit.sourceNodeRunId,
									cachedAt: hit.cachedAt,
								},
								hit.data,
							);
							await recordPostExecution(ctx, cachePolicy, "success");
							ctx.logger.log(`${stepPrefix} → cached (from run ${hit.sourceRunId})`);
							continue;
						}
					}

					ctx.logger.log(`${stepPrefix} → started`);
					const stepStart = performance.now();

					// === Tier 1: retry loop ===
					// Wraps step.process() with capped exponential backoff per
					// `step.retry`. Default `maxAttempts: 1` preserves
					// pre-Phase-4 behaviour exactly (single attempt, no retry).
					// Soft errors (model.data.error returned from the SDK)
					// participate in retry alongside thrown errors — both flow
					// through the catch block below.
					const retryConfig = (step as NodeBase).retry;
					const maxAttempts = retryConfig ? Math.max(1, retryConfig.maxAttempts) : 1;
					// Tier 2 quick-wins — per-attempt timeout. When unset, the
					// step runs without a cap. Numeric `maxDurationMs` arrives
					// pre-parsed from `Configuration` (string `"30s"` →
					// `30000` via `parseDuration`).
					const maxDurationMs = (step as NodeBase).maxDurationMs;
					let attempt = 0;
					let policyToken: PolicyToken | null = null;

					// v0.6 Phase 4 — the primitive stack on ctx is owned by
					// ForEachNode/LoopNode/SwitchNode (push on entry, pop in
					// finally). The Phase 2/3 single-slot
					// `_blokActivePrimitiveNodeRunId` mechanism is gone —
					// nested primitives each register their own frame, and
					// the wait-throw site walks the full stack.

					// === OBS-02 B4 — per-step OTel child span ===
					// One span per EXECUTING leaf step, nested under the workflow span.
					// `wait` + idempotency-cache-hit steps continue above this point, so only
					// steps that actually invoke process() reach here. Made active around
					// process() so a gRPC runtime call / http-self sub-workflow dispatch
					// (B2.2/B2.3) nests beneath it. No-op + zero overhead when no provider
					// is registered (OTel API guarantee).
					const stepSpan = stepTracer.startSpan(`step ${step.name}`, {
						kind: SpanKind.INTERNAL,
						attributes: {
							"blok.step.id": step.name,
							"blok.step.index": i,
							"blok.node.name": step.name,
							"blok.node.type": stepType,
							...(stepAny.runtime ? { "blok.runtime.kind": stepAny.runtime as string } : {}),
						},
					});

					try {
						while (true) {
							attempt += 1;

							try {
								policyToken = await authorizeStep(ctx, step, attempt);
								// Run process() inside the step span's context so child spans
								// (gRPC runtime / sub-workflow dispatch) nest under it.
								const processInvocation = (): Promise<{ data: unknown }> =>
									context.with(trace.setSpan(context.active(), stepSpan), () =>
										step.process(ctx, step as unknown as Step),
									);
								const model =
									typeof maxDurationMs === "number" && maxDurationMs > 0
										? await wrapWithTimeout(processInvocation, maxDurationMs, step.name)
										: await processInvocation();
								ctx.response = model.data as BlokResponse;

								// Treat soft errors (data carries `.error`) the same as
								// thrown errors so retry semantics are uniform.
								if (ctx.response?.error) {
									throw ctx.response.error;
								}
								// H1-02 — custom RunnerNode implementations and cache
								// replays have no lower publication hook. Enforce here
								// before the post-execution audit reports success. Built-in
								// Blok/runtime nodes also validate before publication.
								enforceStepOutput(step, stepOutput(model.data));
								await recordPostExecution(ctx, policyToken, "success");

								// === Tier 1: idempotency cache write ===
								// Cache on the success path only — failed steps are
								// re-runnable. Honour `idempotencyKeyTTL` per step;
								// default 24h. A TTL of 0 stores an immediately-
								// expired entry (useful as a kill-switch).
								if (cacheStore && resolvedIdemKey && nodeRunId && traceRunId) {
									const ttlField = (step as NodeBase).idempotencyKeyTTL;
									const ttlMs = typeof ttlField === "number" ? ttlField : DEFAULT_IDEMPOTENCY_TTL_MS;
									const now = Date.now();
									const expiresAt = ttlMs > 0 ? now + ttlMs : now - 1;
									cacheStore.setIdempotencyCache(workflowName, step.name, resolvedIdemKey, {
										data: model.data,
										cachedAt: now,
										expiresAt,
										sourceRunId: traceRunId,
										sourceNodeRunId: nodeRunId,
									});
								}

								const stepDuration = (performance.now() - stepStart).toFixed(1);

								// --- Trace: complete node ---
								if (tracker && nodeRunId) {
									// `_stepMetrics` is stashed on ctx by RuntimeAdapterNode
									// when an adapter returns metrics (gRPC wire bytes,
									// duration, cpu, memory). Threading it through
									// `completeNode` is what gets the metrics into the
									// run store + NODE_COMPLETED event payload — Studio's
									// inspector reads them from there.
									const ctxAny = ctx as Record<string, unknown>;
									const stepMetrics = ctxAny._stepMetrics as Parameters<typeof tracker.completeNode>[2];
									ctxAny._stepMetrics = undefined;
									tracker.completeNode(nodeRunId, sanitize(ctx.response.data), stepMetrics);
									// PR 4 — advance the resume cursor after each
									// successful non-wait step. A subsequent wait step
									// reads this value to set its own cursor before
									// throwing WaitDispatchRequest. Only at top-level
									// (deep=false); nested branch flow doesn't update.
									if (!deep && traceRunId) {
										tracker.getStore().updateRun(traceRunId, { lastCompletedStepIndex: i });
									}
								}

								const attemptSuffix = attempt > 1 ? ` after ${attempt} attempts` : "";
								ctx.logger.log(`${stepPrefix} → completed (${stepDuration}ms${attemptSuffix})`);
								stepSpan.setStatus({ code: SpanStatusCode.OK });
								break;
							} catch (nodeErr) {
								if (
									nodeErr instanceof PolicyAuditError ||
									nodeErr instanceof PolicyDeniedError ||
									nodeErr instanceof PolicyInteractionRequiredError
								) {
									throw nodeErr;
								}
								if (policyToken)
									await recordPostExecution(
										ctx,
										policyToken,
										ctx.signal?.aborted ? "cancelled" : "failure",
										nodeErr instanceof Error ? nodeErr.name : undefined,
									);
								// v0.5.3 — control-flow signals from a step's run()
								// must NOT be retried OR wrapped as enriched errors.
								// In the production wait path, RunnerSteps throws
								// WaitDispatchRequest from outside this retry loop, so
								// this branch is normally inert. But if a custom node
								// ever throws a wait/cancel signal from inside its
								// process()/run(), preserve the type so the outer
								// catch + TryCatchNode pass-through still recognise
								// it. Same rationale as the outer-catch instanceof
								// guards at line ~498.
								if (nodeErr instanceof WaitDispatchRequest || nodeErr instanceof RunCancelledError) {
									throw nodeErr;
								}
								// #679 — classify ONCE. The same verdict decides whether
								// this step retries AND (once stamped on the propagating
								// error below) whether the transport's job-level retry
								// fires, so the two can never disagree. Evaluated even on
								// the final attempt, which the retry branch short-circuits
								// past.
								const nonRetryable =
									nodeErr instanceof EnforcementViolationError ||
									isNonRetryableError(nodeErr, retryConfig?.nonRetryableErrorNames);
								if (attempt < maxAttempts && retryConfig && !nonRetryable) {
									// More attempts remain — record this as a soft
									// failure and back off before retrying. The node
									// stays in `running` status; failNode is the
									// terminal call.
									if (tracker && nodeRunId) {
										tracker.recordNodeAttemptFailed(nodeRunId, { attempt, error: nodeErr });
									}
									const backoffMs = computeBackoff(retryConfig, attempt);
									const errMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
									ctx.logger.log(
										`${stepPrefix} → attempt ${attempt}/${maxAttempts} failed (${errMsg}), retrying in ${backoffMs}ms`,
									);
									await sleep(backoffMs);
									continue;
								}

								// Final attempt — fail the node and propagate the
								// enriched error so RunnerSteps' outer catch can
								// wrap it as a GlobalError.
								if (tracker && nodeRunId) {
									const existing = tracker.getNodeRun(nodeRunId);
									if (existing && existing.status === "running") {
										tracker.failNode(nodeRunId, nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)));
									}
								}
								// Tier 2 quick-wins — final-attempt timeout flips
								// the run to "timedOut" (distinct from "failed").
								// Only when the FINAL error was a StepTimeoutError;
								// mixed failures (some retries timed out, final
								// retry threw a different error) keep the normal
								// "failed" status.
								if (
									tracker &&
									traceRunId &&
									typeof maxDurationMs === "number" &&
									maxDurationMs > 0 &&
									nodeErr instanceof StepTimeoutError
								) {
									tracker.markRunTimedOut(traceRunId, {
										stepId: step.name,
										maxDurationMs,
										attemptsExhausted: attempt,
									});
								}
								const stepDuration = (performance.now() - stepStart).toFixed(1);
								const attemptSuffix = attempt > 1 ? ` after ${attempt} attempts` : "";
								ctx.logger.log(`${stepPrefix} → FAILED (${stepDuration}ms${attemptSuffix})`);

								// Enrich error with step context so developers know which step failed.
								// Attach `_blokStepId` directly on the wrap so TryCatchNode's
								// envelope construction can surface `ctx.error.stepId` to authors
								// without parsing the prefix back out of the message string.
								const originalMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
								const enrichedError = new Error(`${stepPrefix} failed: ${originalMsg}`);
								const enrichedAny = enrichedError as Error & {
									cause?: unknown;
									_blokStepId?: string;
								};
								enrichedAny.cause = nodeErr;
								enrichedAny._blokStepId = step.name;
								// #679 — carry the step-level verdict outward so the worker
								// trigger's catch can make the JOB terminal too (BullMQ
								// `discard`, other adapters' DLQ) instead of replaying a
								// failure that is deterministic by declaration.
								if (nonRetryable) markNonRetryableStepError(enrichedError);
								stepSpan.recordException(nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)));
								stepSpan.setStatus({ code: SpanStatusCode.ERROR, message: originalMsg });
								throw enrichedError;
							}
						}
					} finally {
						// OBS-02 B4 — close the per-step span on every exit (success / failure /
						// wait / cancel / timeout).
						stepSpan.end();
					}
				} else {
					stepName = step.name;
					flow_steps = (await step.processFlow(ctx)).data as NodeBase[];

					flow = true;
					flow_step = i;

					break;
				}
			}

			if (flow) {
				const nextSteps = steps.length > flow_step + 1 ? steps.slice(flow_step + 1) : [];
				return await this.runSteps(ctx, [...flow_steps, ...nextSteps], true, stepName);
			}
		} catch (e: unknown) {
			// PR 1 follow-up · A2 fix companion. RunCancelledError carries
			// the cancellation contract end-to-end — wrapping it as
			// GlobalError would defeat TriggerBase.run's `instanceof
			// RunCancelledError` discrimination and the run would get
			// failRun'd on top of an already-cancelled status. Pass through
			// untouched so the catch in TriggerBase.run sees the right type.
			if (
				e instanceof RunCancelledError ||
				e instanceof PolicyDeniedError ||
				e instanceof PolicyInteractionRequiredError ||
				e instanceof PolicyAuditError
			) {
				throw e;
			}

			// PR 4 — WaitDispatchRequest is the wait.for / wait.until
			// step's signal to TriggerBase that it should schedule a
			// deferred dispatch. Same pass-through rationale as
			// RunCancelledError — the catch in TriggerBase.run translates
			// it to DeferredDispatchSignal + 202.
			if (e instanceof WaitDispatchRequest) {
				throw e;
			}

			// Capture the step-enrichment wrap's `_blokStepId` BEFORE we
			// unwrap past it. The wrap is the outermost layer (set inside
			// the inner-try retry loop above); after unwrapping to the inner
			// GlobalError this metadata would otherwise be lost. Surfaces to
			// authors as `ctx.error.stepId` inside tryCatch.catch arms.
			const wrapStepId =
				typeof e === "object" && e !== null && "_blokStepId" in e
					? (e as { _blokStepId?: unknown })._blokStepId
					: undefined;

			throw this.unwrapAndEnrichError(e, wrapStepId);
		}

		return ctx;
	}

	/**
	 * PR 4 — wait.for / wait.until resume cursor.
	 *
	 * On `dispatchDeferred` re-entry from a wait step, the runner must skip
	 * past pre-wait steps that already completed in the previous pass.
	 * `lastCompletedStepIndex` is set on the run record before each
	 * WaitDispatchRequest throw and read here at runSteps entry. Default
	 * `-1` = no resume; runner starts at i = 0. Extracted verbatim from the
	 * top of `runSteps` (E06-T002) — the only mutation is clearing the
	 * `_blokInnerResumeIndex` sentinel.
	 */
	private resolveResumeCursor(ctx: Context, deep: boolean, tracker: RunTracker | null, traceRunId: string | undefined) {
		const persistedRun = !deep && tracker && traceRunId ? tracker.getStore().getRun(traceRunId) : undefined;
		// Two cursor sources:
		//   - Top-level (deep === false): workflow_runs.lastCompletedStepIndex.
		//   - Nested inside a primitive iterator (deep === true, v0.6
		//     Phase 2): `_blokInnerResumeIndex` stamped on the child ctx
		//     by ForEachNode.runIteration when resuming at a specific
		//     inner step. Undefined = start at 0 (fresh iteration body).
		const innerResumeIndexRaw = (ctx as Record<string, unknown>)._blokInnerResumeIndex;
		const innerResumeIndex = typeof innerResumeIndexRaw === "number" ? innerResumeIndexRaw : undefined;
		const resumeFromIndex = !deep
			? persistedRun?.lastCompletedStepIndex !== undefined
				? persistedRun.lastCompletedStepIndex + 1
				: 0
			: (innerResumeIndex ?? 0);
		// Clear the sentinel so a re-runner started fresh from this
		// childCtx (e.g. the nested branch flow path) doesn't inherit
		// a stale resume hint. ForEachNode set it for THIS one re-entry
		// only; it should not propagate further.
		if (deep && innerResumeIndex !== undefined) {
			(ctx as Record<string, unknown>)._blokInnerResumeIndex = undefined;
		}
		return { resumeFromIndex, persistedRun, innerResumeIndex };
	}

	/**
	 * Unwrap + enrich a caught error into a `GlobalError`: walk the
	 * `.cause` chain looking for an inner `GlobalError` (so an author's
	 * structured rejection survives the framework's `[step N/M] X
	 * failed: ...` wrap), otherwise build a fresh `GlobalError` that
	 * preserves the original chain via `.cause`, then stamp the wrap's
	 * `_blokStepId` back on so `TryCatchNode.toErrorEnvelope` can surface
	 * it as `ctx.error.stepId`. Pure — no ctx mutation. Extracted verbatim
	 * from the `runSteps` catch arm (E06-T002).
	 */
	private unwrapAndEnrichError(e: unknown, wrapStepId?: unknown): GlobalError {
		let error_context = <Error>{};
		if (e instanceof GlobalError) {
			error_context = e as GlobalError;
		} else {
			// Walk the `.cause` chain looking for a GlobalError. The
			// step-enrichment wrap at line ~465 sets `cause = nodeErr`,
			// and `nodeErr` may itself be a GlobalError thrown from
			// `defineNode`-built nodes (e.g. `@blokjs/throw` setting
			// `code: 401` for an auth-check middleware). Without this
			// walk, the outer wrap below would force the framework's
			// generic `[step N/M] X failed: ...` message + default 500
			// code, clobbering the author's structured rejection.
			let inner: unknown = e;
			let foundGlobal: GlobalError | null = null;
			while (
				typeof inner === "object" &&
				inner !== null &&
				"cause" in inner &&
				(inner as { cause?: unknown }).cause !== undefined &&
				(inner as { cause?: unknown }).cause !== inner
			) {
				inner = (inner as { cause: unknown }).cause;
				if (inner instanceof GlobalError) {
					foundGlobal = inner;
					break;
				}
			}
			if (foundGlobal) {
				error_context = foundGlobal;
			} else {
				error_context = new GlobalError((e as Error).message);
				// Preserve the original error chain so outer handlers
				// (notably v0.5 TryCatchNode's `ctx.error.message` resolution)
				// can peel back through `.cause` to the author's original
				// `throw new Error("...")` text instead of the runner's
				// `[step N/M] <name> failed: ...` enriched prefix.
				(error_context as Error & { cause?: unknown }).cause = e;
			}
		}

		// Stamp the wrap's stepId on the unwrapped error so TryCatchNode's
		// `toErrorEnvelope` walk can surface it as `ctx.error.stepId`. The
		// inner-try wrap layer is gone by this point; this is the only
		// place where the runner can identify which sub-step failed.
		if (typeof wrapStepId === "string" && wrapStepId.length > 0) {
			(error_context as Error & { _blokStepId?: string })._blokStepId = wrapStepId;
		}

		// #679 — same rationale for the non-retryable verdict: when the
		// unwrap above swaps the outer wrap (which carries the stamp) for an
		// inner GlobalError, the stamp would be dropped and the transport
		// would replay a failure the step already declared deterministic.
		if (isNonRetryableStepError(e)) markNonRetryableStepError(error_context);

		return error_context as GlobalError;
	}
}
